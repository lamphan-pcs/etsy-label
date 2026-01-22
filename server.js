const express = require("express");
const multer = require("multer");
const path = require("path");
const { processLabels } = require("./src/processor");

const app = express();
const upload = multer({ storage: multer.memoryStorage() }); // Store files in memory buffer

const PORT = process.env.PORT || 3000;

// Serve static files from 'public' directory
app.use(express.static("public"));

// API Endpoint to handle file upload and processing
app.post(
    "/merge",
    upload.fields([
        { name: "label1", maxCount: 1 },
        { name: "label2", maxCount: 1 },
    ]),
    async (req, res) => {
        try {
            if (!req.files || !req.files["label1"] || !req.files["label2"]) {
                return res
                    .status(400)
                    .send("Please upload both Label 1 and Label 2.");
            }

            const label1Buffer = req.files["label1"][0].buffer;
            const label2Buffer = req.files["label2"][0].buffer;

            console.log("Processing labels...");
            try {
                const { pdfBytes, filename } = await processLabels(
                    label1Buffer,
                    label2Buffer,
                );

                // Sanitize filename to be safe for HTTP headers
                const safeFilename = filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");

                res.setHeader("Content-Type", "application/octet-stream");
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${safeFilename}"`,
                );

                // Add custom header so client knows the filename even if browser handles download differently
                res.setHeader("X-Suggested-Filename", safeFilename);

                res.send(Buffer.from(pdfBytes));
                console.log(`Labels processed. Sending: ${safeFilename}`);
            } catch (procError) {
                console.error("Error processing PDF:", procError);
                res.status(500).send(
                    "Error processing the PDF files. Ensure they are valid PDFs.",
                );
            }
        } catch (error) {
            console.error("Server error:", error);
            res.status(500).send("Internal Server Error");
        }
    },
);

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

module.exports = app;
