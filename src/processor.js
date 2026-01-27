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
    visualLeftMargin: 31,
    visualRightMargin: 68,
};

// "Left Half" (Bottom Label) - Needs less cropping on Left/Right
const BULK_CROP_BOTTOM = {
    visualTopMargin: 70,
    visualBottomMargin: 70,
    visualLeftMargin: 68, // Reduced from 20 ("left margin should be less")
    visualRightMargin: 32, // Reduced from 60 ("right margin is too much cropped")
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

            return {
                id: orderId,
                type: "etsy",
                date: formattedDate,
                tracking: tracking,
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

    // Auto-detect if Label 1 contains an Order ID (implies it needs Bulk-style cropping)
    // Only applies if not already in bulk mode
    if (!isBulk) {
        try {
            const meta = await extractLabelData(label1Buffer);
            if (meta && meta.id) {
                console.log(
                    `Detected Order ID ${meta.id} in matching label. using Bulk Crop config (Top).`,
                );
                isBulk = true;
                position = "top";
            }
        } catch (e) {
            console.warn("Error checking label content:", e);
        }
    }

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

        // Save individual page as buffer to read text
        const singlePageDoc = await PDFDocument.create();
        const [copiedPage] = await singlePageDoc.copyPages(pdfDoc, [i]);
        singlePageDoc.addPage(copiedPage);
        const pageBuffer = Buffer.from(await singlePageDoc.save());

        const ids = await getPageIds(pageBuffer);

        if (ids.length === 0) continue;

        // TOP HALF
        // Always exists if we have at least 1 ID
        const topDoc = await PDFDocument.create();
        // Embed the single page PDF into the new Top Document so we can draw it
        const [embeddedTop] = await topDoc.embedPdf(pageBuffer);
        const topPage = topDoc.addPage([width, height / 2]);

        // Draw the full page shifted down so the Top Half (y=H/2 to H) sits at (y=0 to H/2)
        topPage.drawPage(embeddedTop, {
            x: 0,
            y: -height / 2, // Shift down
            width: width,
            height: height,
        });
        const topBuffer = Buffer.from(await topDoc.save());

        extractedLabels.push({
            id: ids[0],
            buffer: topBuffer,
            position: "top",
        });
        console.log(`Found Bulk Label ID (Top): ${ids[0]}`);

        // BOTTOM HALF
        // Only if we have 2 IDs
        if (ids.length >= 2) {
            const botDoc = await PDFDocument.create();
            // Embed the single page PDF into the new Bottom Document so we can draw it
            const [embeddedBot] = await botDoc.embedPdf(pageBuffer);
            const botPage = botDoc.addPage([width, height / 2]);

            // Draw the full page at 0,0 so the Bottom Half (y=0 to H/2) sits at (y=0 to H/2)
            botPage.drawPage(embeddedBot, {
                x: 0,
                y: 0,
                width: width,
                height: height,
            });
            const botBuffer = Buffer.from(await botDoc.save());

            extractedLabels.push({
                id: ids[1],
                buffer: botBuffer,
                position: "bottom",
            });
            console.log(`Found Bulk Label ID (Bottom): ${ids[1]}`);
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

module.exports = {
    processLabels,
    extractLabelData,
    extractBulkLabels,
    extractBulkSlips,
};
