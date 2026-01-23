const { PDFDocument, degrees } = require("pdf-lib");
const pdfParse = require("pdf-parse");

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
        const tiktokMatch = text.match(/Order ID:\s*([A-Za-z0-9]+)/i);
        if (tiktokMatch) {
            return {
                id: tiktokMatch[1].trim(),
                type: "tiktok",
                date: "-",
                tracking: "-",
            };
        }

        // Etsy pattern: "Order #xxxxxxxx"
        const etsyMatch = text.match(/Order\s*#\s*([A-Za-z0-9]+)/i);
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
 * @returns {Promise<{pdfBytes: Uint8Array, filename: string}>} - The combined PDF bytes and suggested filename.
 */
async function processLabels(label1Buffer, label2Buffer) {
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
    // User sees the label on the "Right Half" of the rotated page.
    // 90deg CW Rotation:
    // - Original Top Edge    -> Visual Right Edge
    // - Original Bottom Edge -> Visual Left Edge
    // - Original Left Edge   -> Visual Top Edge
    // - Original Right Edge  -> Visual Bottom Edge

    // Requirements: "cut a bit more on top/bot & a bit more on right side after rotation"

    // 1. Visual Top/Bot corresponds to Original Left/Right (X-axis).
    const visualTopBotMargin = 40; // Increased from 10

    // 2. Visual Right corresponds to Original Top (Y-axis end).
    const visualRightMargin = 40; // Increased from 10

    // 3. Visual Left corresponds to Original Middle (Y-axis start).
    const visualLeftMargin = 10; // Keep small

    page1.setCropBox(
        visualTopBotMargin, // x (Visual Top)
        height / 2 + visualLeftMargin, // y (Visual Left)
        width - visualTopBotMargin * 2, // width (Visual Top + Bottom)
        height / 2 - visualLeftMargin - visualRightMargin, // height (Visual Left + Right)
    );

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

module.exports = { processLabels, extractLabelData };
