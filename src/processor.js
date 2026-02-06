const { PDFDocument, degrees } = require("pdf-lib");
const pdfParse = require("pdf-parse");

// --- CROP CONFIGURATION ---
const DEFAULT_CROP = {
    visualTopMargin: 40,
    visualBottomMargin: 40,
    visualLeftMargin: 10,
    visualRightMargin: 40,
};

// "Right Half" (Top Label) - Works well with default bulk settings
const BULK_CROP_TOP = {
    visualTopMargin: 70,
    visualBottomMargin: 70,
    visualLeftMargin: 27,
    visualRightMargin: 64,
};

// "Left Half" (Bottom Label) - Needs less cropping on Left/Right
const BULK_CROP_BOTTOM = {
    visualTopMargin: 70,
    visualBottomMargin: 70,
    visualLeftMargin: 64, // Reduced from 20 ("left margin should be less")
    visualRightMargin: 28, // Reduced from 60 ("right margin is too much cropped")
};

/**
 * Extracts metadata from PDF text based on TikTok or Etsy patterns.
 * @param {Buffer} buffer - PDF file buffer
 * @returns {Promise<Object|null>} - Extracted metadata or null
 */
async function extractLabelData(buffer) {
    try {
        const data = await pdfParse(buffer);
        const text = data.text;

        // TikTok pattern: "Order ID: xxxxxxxxxx"
        const tiktokMatch = text.match(/Order ID:\s*(\d+)/i);
        if (tiktokMatch) {
            return {
                id: tiktokMatch[1].trim(),
                type: "tiktok",
                date: "-",
                tracking: "-",
            };
        }

        // Etsy pattern: "Order #xxxxxxxx"
        // Also handles "Order #: xxxxx" pattern (User Example: "Order #: 3953698770")
        // Regex Explanation:
        // Order\s* : Matches "Order" followed by optional whitespace
        // (?:#|ID) : Non-capturing group matching "#" OR "ID"
        // [:\s]*   : Matches optional colon and whitespace
        // (\d+)    : Capturing group for the ID (Digits only to avoid capturing "Buyer" suffix)
        const etsyMatch = text.match(/Order\s*(?:#|ID)[:\s]*(\d+)/i);
        if (etsyMatch) {
            const orderId = etsyMatch[1].trim();

            // Extract Date: "Order date\nJan 22, 2026"
            // Matches "Jan 22, 2026" or similar
            const dateMatch = text.match(
                /Order date\s*\n\s*([A-Za-z]{3}\s\d{1,2},\s\d{4})/i,
            );
            let formattedDate = "-";
            if (dateMatch) {
                const dateStr = dateMatch[1].trim();
                const d = new Date(dateStr);
                if (!isNaN(d.getTime())) {
                    // Format as MM/DD/YYYY
                    const mm = String(d.getMonth() + 1).padStart(2, "0");
                    const dd = String(d.getDate()).padStart(2, "0");
                    const yyyy = d.getFullYear();
                    formattedDate = `${mm}/${dd}/${yyyy}`;
                } else {
                    formattedDate = dateStr;
                }
            }

            // Extract Tracking: "Tracking\n9400..."
            const trackingMatch = text.match(/Tracking\s*\n\s*(\d+)/i);
            const tracking = trackingMatch ? trackingMatch[1].trim() : "-";

            // Extract Buyer Info: "Buyer\nChelsy Rosa\n(chelsyns)"
            // Regex explanations:
            // Buyer[:\s]+  : Matches "Buyer" followed by colon/whitespace (newlines included)
            // (.*?)        : Non-greedy capture of Name (matches until the next part)
            // \s*\(        : Optional whitespace followed by opening paren
            // ([^)]+)      : Capture Username contents
            // \)           : Closing paren
            const buyerMatch = text.match(/Buyer[:\s]+(.*?)\s*\(([^)]+)\)/i);
            const buyerName = buyerMatch ? buyerMatch[1].trim() : "-";
            const buyerUsername = buyerMatch ? buyerMatch[2].trim() : "-";

            return {
                id: orderId,
                type: "etsy",
                date: formattedDate,
                tracking: tracking,
                buyerName: buyerName,
                buyerUsername: buyerUsername,
            };
        }

        return null; // Return null if no match found
    } catch (error) {
        console.error("Error parsing PDF text:", error);
        return null;
    }
}

/**
 * Processes two label PDFs according to the requirements:
 * 1. Takes Label 1 (e.g., UPS), crops it to a fixed area, and rotates it.
 * 2. Takes Label 2.
 * 3. Combines them into a single PDF.
 *
 * @param {Buffer} label1Buffer - Buffer of the first PDF (to be cropped/rotated).
 * @param {Buffer} label2Buffer - Buffer of the second PDF.
 * @param {Object} options - Configuration object { isBulk, position }
 * @returns {Promise<{pdfBytes: Uint8Array, filename: string}>} - The combined PDF bytes and suggested filename.
 */
async function processLabels(label1Buffer, label2Buffer, options = {}) {
    // Determine config
    let isBulk = options.isBulk || false;
    let position = options.position || "top"; // Default to top/standard behavior

    // Create a new PDF document
    const mergedPdf = await PDFDocument.create();

    // Load the source PDFs
    const pdf1 = await PDFDocument.load(label1Buffer);
    const pdf2 = await PDFDocument.load(label2Buffer);

    // --- Process Label 1 ---
    // Copy the first page of label 1
    const [page1] = await mergedPdf.copyPages(pdf1, [0]);

    // Dimensions of the page
    const { width, height } = page1.getSize();
    console.log(`Label 1 Dimensions: ${width}x${height}`);

    // Auto-detect if Label 1 contains an Order ID (implies it needs Bulk-style cropping)
    // Only applies if not already in bulk mode AND if the page is large (e.g. Letter size)
    // We avoid doing this for small pages (4x6) to prevent accidental over-cropping.
    if (!isBulk && height > 600) {
        try {
            // 1. Get the Target Order ID from the Slip (Label 2)
            const slipMeta = await extractLabelData(label2Buffer);
            const targetOrderId = slipMeta ? slipMeta.id : null;

            if (targetOrderId) {
                // 2. Scan Label 1 for ALL Order IDs
                const data = await pdfParse(label1Buffer);
                const text = data.text;
                // Match all Order IDs
                const matches = [
                    ...text.matchAll(/Order\s*(?:#|ID)[:\s]*(\d+)/gi),
                ].map((m) => m[1]);

                if (matches.length > 0) {
                    // Check if our target ID exists in the label file
                    const index = matches.indexOf(targetOrderId);

                    if (index !== -1) {
                        console.log(
                            `Auto-detected matches in Label File: ${matches.join(", ")}`,
                        );
                        isBulk = true;
                        // If it's the second match (index 1), assume it's the bottom label
                        if (index === 1) {
                            position = "bottom";
                            console.log(
                                `Target ${targetOrderId} is match #${index + 1} -> Selecting BOTTOM half.`,
                            );
                        } else {
                            position = "top";
                            console.log(
                                `Target ${targetOrderId} is match #${index + 1} -> Selecting TOP half.`,
                            );
                        }
                    } else {
                        // ID not found in label file text, but filename matched?
                        // Or user just dragged random files.
                        // If matches exist but don't match target, we might be looking at the wrong file or wrong half.
                        // Check if maybe it's just a "First Available" fallback?
                        // For safety, if we found Order IDs but NOT our target, do we switch to bulk?
                        // Maybe not. If we switch to bulk Top, we might show the wrong label.
                        // But if we don't switch, we show the whole page (uncropped) which is also bad (2 labels on 1 page).
                        // Let's assume if IDs are present, it's a Label Sheet. Default to Top is safer than Full Page.
                        console.log(
                            "Order IDs found but no match for target. Defaulting to Bulk Top.",
                        );
                        isBulk = true;
                        position = "top";
                    }
                }
            } else {
                // No ID in slip? Can't match.
                // Check if label has ID anyway to trigger crop?
                const meta = await extractLabelData(label1Buffer);
                if (meta && meta.id) {
                    isBulk = true;
                    position = "top";
                }
            }
        } catch (e) {
            console.warn("Error checking label content:", e);
        }
    }

    // Rotate first (90 degrees clockwise)
    page1.setRotation(degrees(90));

    // Crop Logic:
    let config = DEFAULT_CROP;
    if (isBulk) {
        if (position === "bottom") {
            config = BULK_CROP_BOTTOM;
        } else {
            config = BULK_CROP_TOP;
        }
    }

    // Fallback for old config structure if needed (though we updated both just now)
    const visualTopMargin =
        config.visualTopMargin !== undefined
            ? config.visualTopMargin
            : config.visualTopBotMargin || 0;
    const visualBottomMargin =
        config.visualBottomMargin !== undefined
            ? config.visualBottomMargin
            : config.visualTopBotMargin || 0;
    const { visualRightMargin, visualLeftMargin } = config;

    // Handling Half-Page Inputs (Bulk Mode) vs Full Page Inputs (Standard Mode)
    // A standard Letter page is ~792 points high. Half page is ~396.
    // If height is small, we assume it's already a single label (half-sheet).
    if (height < 500) {
        // Half-Sheet logic: The label occupies the FULL height (since we already cropped/split it).
        // Rotate 90deg means:
        // Top Edge -> Right Edge
        // Bot Edge -> Left Edge
        // Left Edge -> Top
        // Right Edge -> Bot

        // We want to crop margins around the content.
        // With SetCropBox(x, y, w, h) in *unrotated* space:
        // x,y is bottom-left.
        // Visual Top = Unrotated Left (x) -> Remove visualTopMargin
        // Visual Bottom = Unrotated Right (x+w) -> Remove visualBottomMargin
        // Visual Left = Unrotated Bottom (y) -> Remove visualLeftMargin
        // Visual Right = Unrotated Top (y+h) -> Remove visualRightMargin

        page1.setCropBox(
            visualTopMargin, // x
            visualLeftMargin, // y (start near bottom)
            width - visualTopMargin - visualBottomMargin, // w
            height - visualLeftMargin - visualRightMargin, // h
        );
    } else {
        // Standard Full-Page Logic (Label is in Top Half)
        page1.setCropBox(
            visualTopMargin, // x (Visual Top / Unrotated Left)
            height / 2 + visualLeftMargin, // y (Visual Left / Unrotated Bottom of top half?)
            width - visualTopMargin - visualBottomMargin, // width
            height / 2 - visualLeftMargin - visualRightMargin, // height
        );
    }

    console.log(`Applied CropBox with specific margins.`);

    // Add page 1
    mergedPdf.addPage(page1);

    // --- Process Label 2 ---
    // Copy all pages of label 2
    const pageIndices2 = pdf2.getPageIndices();
    const pages2 = await mergedPdf.copyPages(pdf2, pageIndices2);

    pages2.forEach((page) => mergedPdf.addPage(page));

    // Determine filename based on content of Label 2
    const orderInfo = await extractLabelData(label2Buffer);
    let filename = "combined-label";
    let metadata = {
        orderId: "-",
        date: "-",
        tracking: "-",
        type: "unknown",
    };

    if (orderInfo) {
        if (orderInfo.type === "tiktok" || orderInfo.type === "etsy") {
            filename = `${orderInfo.id}`;
        }
        metadata = {
            orderId: orderInfo.id,
            date: orderInfo.date,
            tracking: orderInfo.tracking,
            type: orderInfo.type,
            buyerName: orderInfo.buyerName || "-",
            buyerUsername: orderInfo.buyerUsername || "-",
        };
    }

    // Return the merged PDF bytes, filename and metadata
    const pdfBytes = await mergedPdf.save();
    return { pdfBytes, filename, metadata };
}

/**
 * Splits a PDF page into two halves (Top/Bottom), extracts their Order IDs,
 * and returns the buffers as "simulated single label files".
 *
 * @param {Buffer} buffer - The Bulk Label PDF
 * @returns {Promise<Array<{id: string, buffer: Buffer}>>}
 */
async function extractBulkLabels(buffer) {
    // Check for exclusion marker first (User detected confusion)
    if (await isSlip(buffer)) {
        console.log(
            "File detected as Slip via 'rubyvibeco.etsy.com' marker. Skipping label extraction.",
        );
        return [];
    }

    const pdfDoc = await PDFDocument.load(buffer);
    const pageCount = pdfDoc.getPageCount();
    const extractedLabels = [];

    // Helper to extract all Order IDs from a page's text
    // We assume the text order corresponds to visual top->bottom order
    const getPageIds = async (pageBuffer) => {
        try {
            const data = await pdfParse(pageBuffer);
            const text = data.text;
            // Find all matches
            // Matches "Order #12345", "Order #: 12345", "Order ID: 12345"
            // User example: "Order #: 3953698770"
            // Using \d+ to ensure we don't capture trailing text like "Buyer"
            const regex = /Order\s*(?:#|ID)[:\s]*(\d+)/gi;
            const matches = [...text.matchAll(regex)];
            return matches.map((m) => m[1]);
        } catch (e) {
            return [];
        }
    };

    for (let i = 0; i < pageCount; i++) {
        const page = pdfDoc.getPage(i);
        const { width, height } = page.getSize();

        // 1. Create Buffers for Physical Splits straight away
        // This helps us isolate text extraction if needed
        const singlePageDoc = await PDFDocument.create();
        const [copiedPage] = await singlePageDoc.copyPages(pdfDoc, [i]);
        singlePageDoc.addPage(copiedPage);
        const pageBuffer = Buffer.from(await singlePageDoc.save());

        // --- PREPARE SPLIT BUFFERS ---
        // Top Half
        const topDoc = await PDFDocument.create();
        const [embeddedTop] = await topDoc.embedPdf(pageBuffer);
        const topPage = topDoc.addPage([width, height / 2]);
        topPage.drawPage(embeddedTop, { x: 0, y: -height / 2, width, height });
        const topBuffer = Buffer.from(await topDoc.save());

        // Bottom Half
        const botDoc = await PDFDocument.create();
        const [embeddedBot] = await botDoc.embedPdf(pageBuffer);
        const botPage = botDoc.addPage([width, height / 2]);
        botPage.drawPage(embeddedBot, { x: 0, y: 0, width, height });
        const botBuffer = Buffer.from(await botDoc.save());

        // 2. Scan for IDs
        // Strategy: Scan the whole page first to know truth.
        // Then scan splits to confirm location if possible.
        const pageIds = await getPageIds(pageBuffer);
        let topIds = await getPageIds(topBuffer);
        let botIds = await getPageIds(botBuffer);

        console.log(`Page ${i + 1}: Found Global IDs: ${pageIds.join(", ")}`);
        console.log(`   Split Top IDs: ${topIds.join(", ")}`);
        console.log(`   Split Bot IDs: ${botIds.join(", ")}`);

        // Heuristic Reconciliation
        let finalTopId = null;
        let finalBotId = null;

        // TOP LOGIC
        if (topIds.length > 0) {
            finalTopId = topIds[0];
        } else if (pageIds.length > 0) {
            // Fallback: First ID on page is likely Top
            finalTopId = pageIds[0];
            console.log(
                `   Fallback: Assigned Top ID ${finalTopId} from global list.`,
            );
        }

        // BOTTOM LOGIC
        if (botIds.length > 0) {
            finalBotId = botIds[0];
        } else if (pageIds.length >= 2) {
            // Fallback: Second ID on page is likely Bottom
            finalBotId = pageIds[1];
            console.log(
                `   Fallback: Assigned Bot ID ${finalBotId} from global list.`,
            );
        } else if (pageIds.length === 1 && topIds.length === 0) {
            // Edge case: 1 ID found globally. Top split found nothing. Bot split found nothing.
            // We assigned it to Top above.
            // Do nothing for Bot.
        }

        // Avoid duplication if logic assigns same ID to both (unlikely given checks, but possible if text matches weirdly)
        if (finalTopId && finalBotId && finalTopId === finalBotId) {
            // If we have 2 distinct page IDs, force them.
            if (pageIds.length >= 2) {
                finalTopId = pageIds[0];
                finalBotId = pageIds[1];
            } else {
                // Only 1 ID exists actually. It shouldn't be bottom.
                finalBotId = null;
            }
        }

        // 3. Register Labels
        if (finalTopId) {
            extractedLabels.push({
                id: finalTopId,
                buffer: topBuffer,
                position: "top",
            });
            console.log(`   -> Registered Top: ${finalTopId}`);
        }

        if (finalBotId) {
            extractedLabels.push({
                id: finalBotId,
                buffer: botBuffer,
                position: "bottom",
            });
            console.log(`   -> Registered Bottom: ${finalBotId}`);
        }
    }

    return extractedLabels;
}

/**
 * Splits a PDF into grouped Slip PDFs based on detected Order IDs.
 *
 * @param {Buffer} buffer - The Bulk Slips PDF
 * @returns {Promise<Array<{id: string, buffer: Buffer, originalName: string}>>}
 */
async function extractBulkSlips(buffer, originalFilename) {
    const pdfDoc = await PDFDocument.load(buffer);
    const pageCount = pdfDoc.getPageCount();

    // Map of OrderID -> Array of Page Indices
    const orderPages = {};
    let currentOrderId = null;

    for (let i = 0; i < pageCount; i++) {
        // Extract text from individual page
        const singleDoc = await PDFDocument.create();
        const [page] = await singleDoc.copyPages(pdfDoc, [i]);
        singleDoc.addPage(page);
        const singleBuffer = Buffer.from(await singleDoc.save());

        const meta = await extractLabelData(singleBuffer);

        if (meta && meta.id) {
            currentOrderId = meta.id;
        }

        if (currentOrderId) {
            if (!orderPages[currentOrderId]) {
                orderPages[currentOrderId] = [];
            }
            orderPages[currentOrderId].push(i);
        }
    }

    const extractedSlips = [];

    for (const [id, indices] of Object.entries(orderPages)) {
        const doc = await PDFDocument.create();
        const pages = await doc.copyPages(pdfDoc, indices);
        pages.forEach((p) => doc.addPage(p));

        const slipBuffer = Buffer.from(await doc.save());
        extractedSlips.push({
            id: id,
            buffer: slipBuffer,
            originalName: `${id}_slip.pdf`,
        });
        console.log(`Grouped ${indices.length} pages for Slip ID: ${id}`);
    }

    return extractedSlips;
}

/**
 * Scans a PDF buffer for all Order IDs present in the text.
 * Useful for matching generic filenames to specific orders.
 * @param {Buffer} buffer
 * @returns {Promise<string[]>} Array of found Order IDs
 */
async function getIdsFromPdf(buffer) {
    try {
        const data = await pdfParse(buffer);
        const text = data.text;
        // Match all Order IDs
        const matches = [...text.matchAll(/Order\s*(?:#|ID)[:\s]*(\d+)/gi)].map(
            (m) => m[1],
        );
        return matches;
    } catch (error) {
        console.error("Error scanning PDF for IDs:", error);
        return [];
    }
}

async function isSlip(buffer) {
    try {
        const data = await pdfParse(buffer);
        return data.text.includes("rubyvibeco.etsy.com");
    } catch (e) {
        return false;
    }
}

module.exports = {
    processLabels,
    extractLabelData,
    extractBulkLabels,
    extractBulkSlips,
    getIdsFromPdf,
    isSlip,
};
