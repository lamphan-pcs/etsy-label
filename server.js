const express = require("express");
const multer = require("multer");
const path = require("path");
const { processLabels, extractLabelData } = require("./src/processor");

const app = express();
const upload = multer({ storage: multer.memoryStorage() }); // Store files in memory buffer

const PORT = process.env.PORT || 3000;

// Serve static files from 'public' directory
app.use(express.static("public"));

// API Endpoint to handle file upload and processing
app.post("/merge", upload.any(), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).send("No files uploaded.");
        }

        const files = req.files;

        // Strategy:
        // 1. Separate into "Shipping Labels" (files with 'label' in name) and "Order Slips" (others)
        // 2. Extract Order IDs from "Order Slips" (using PDF content)
        // 3. Match Order IDs to "Shipping Labels" (using filename)
        // 4. Process matches

        const shippingLabels = [];
        const orderSlips = [];

        files.forEach((f) => {
            if (f.originalname.toLowerCase().includes("label")) {
                shippingLabels.push(f);
            } else {
                orderSlips.push(f);
            }
        });

        const results = [];
        const errors = [];

        console.log(
            `Received ${files.length} files. found ${shippingLabels.length} labels and ${orderSlips.length} slips.`,
        );

        // We iterate through Order Slips as the source of truth for the Order ID
        for (const slip of orderSlips) {
            try {
                const metadata = await extractLabelData(slip.buffer);

                if (!metadata || !metadata.id) {
                    errors.push(
                        `Could not find Order ID in file: ${slip.originalname}`,
                    );
                    continue;
                }

                const orderId = metadata.id;
                console.log(
                    `Slip ${slip.originalname} has Order ID: ${orderId}`,
                );

                // Find matching label file
                // looking for orderId inside the label filename
                const matchingLabel = shippingLabels.find((l) =>
                    l.originalname.includes(orderId),
                );

                if (matchingLabel) {
                    console.log(
                        `Found matching label: ${matchingLabel.originalname}`,
                    );
                    // Process the pair
                    const output = await processLabels(
                        matchingLabel.buffer,
                        slip.buffer,
                    );

                    results.push({
                        filename: output.filename,
                        pdfBase64: Buffer.from(output.pdfBytes).toString(
                            "base64",
                        ),
                        metadata: output.metadata,
                    });
                } else {
                    console.log(`No match for Order ID ${orderId}`);
                    errors.push(
                        `No matching shipping label found for Order ID ${orderId} (from ${slip.originalname})`,
                    );
                }
            } catch (e) {
                console.error(`Error processing slip ${slip.originalname}:`, e);
                errors.push(
                    `Error processing ${slip.originalname}: ${e.message}`,
                );
            }
        }

        if (results.length === 0 && errors.length > 0) {
            return res
                .status(400)
                .send("Processing failed:\n" + errors.join("\n"));
        }

        res.json({
            success: true,
            results: results,
            errors: errors,
        });
    } catch (err) {
        console.error("Server Error:", err);
        res.status(500).send("Server Error: " + err.message);
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

module.exports = app;
