const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs").promises;
const {
    processLabels,
    extractLabelData,
    extractBulkLabels,
    extractBulkSlips,
} = require("./src/processor");
require("dotenv").config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() }); // Store files in memory buffer

const PORT = process.env.PORT || 3000;
// Use INPUT_DIR from .env, or default to internal 'input' folder
let inputDir = process.env.INPUT_DIR || path.join(__dirname, "input");

console.log(`Scanning directory: ${inputDir}`);

// Serve static files from 'public' directory
app.use(express.static("public"));

async function updateEnvFile(newPath) {
    const envPath = path.join(__dirname, ".env");
    let envContent = "";
    try {
        envContent = await fsPromises.readFile(envPath, "utf8");
    } catch (err) {
        // File might not exist, create it
        envContent = "";
    }

    const key = "INPUT_DIR";
    // Escape backslashes for regex? No, newPath is replacement string.
    // But we need to handle backslashes correctly in the file content.
    // Actually, .env usually takes raw strings.

    const newLine = `${key}=${newPath}`;
    const regex = new RegExp(`^${key}=.*`, "m");

    if (envContent.match(regex)) {
        envContent = envContent.replace(regex, newLine);
    } else {
        envContent += `\n${newLine}`;
    }

    await fsPromises.writeFile(envPath, envContent);
    inputDir = newPath; // Update memory
    console.log(`Updated INPUT_DIR to: ${inputDir}`);
}

app.post("/set-input-dir", express.json(), async (req, res) => {
    const { path: newPath } = req.body;
    if (!newPath) {
        return res
            .status(400)
            .json({ success: false, error: "Path is required" });
    }

    // Basic validation: check if existing logic works or if we should create it
    // User asked to "select a default folder", presumably one that exists.
    if (!fs.existsSync(newPath)) {
        return res.status(400).json({
            success: false,
            error: "Directory does not exist on the server.",
        });
    }

    try {
        await updateEnvFile(newPath);
        res.json({ success: true, message: "Directory updated successfully" });
    } catch (err) {
        console.error("Failed to update env:", err);
        res.status(500).json({
            success: false,
            error: "Failed to save configuration",
        });
    }
});

// Helper logic for processing array of file objects
async function processFilePairs(fileObjects) {
    const shippingLabels = [];
    const orderSlips = [];

    fileObjects.forEach((f) => {
        if (f.originalName.toLowerCase().includes("label")) {
            shippingLabels.push(f);
        } else {
            orderSlips.push(f);
        }
    });

    const results = [];
    const errors = [];

    console.log(
        `Processing ${fileObjects.length} files. Found ${shippingLabels.length} labels and ${orderSlips.length} slips.`,
    );

    for (const slip of orderSlips) {
        try {
            const metadata = await extractLabelData(slip.buffer);

            if (!metadata || !metadata.id) {
                errors.push(
                    `Could not find Order ID in file: ${slip.originalName}`,
                );
                continue;
            }

            const orderId = metadata.id;
            console.log(`Slip ${slip.originalName} has Order ID: ${orderId}`);

            const matchingLabel = shippingLabels.find((l) =>
                l.originalName.includes(orderId),
            );

            if (matchingLabel) {
                console.log(
                    `Found matching label: ${matchingLabel.originalName}`,
                );
                const output = await processLabels(
                    matchingLabel.buffer,
                    slip.buffer,
                );

                results.push({
                    filename: output.filename,
                    pdfBase64: Buffer.from(output.pdfBytes).toString("base64"),
                    metadata: output.metadata,
                });
            } else {
                console.log(`No match for Order ID ${orderId}`);
                errors.push(
                    `No matching shipping label found for Order ID ${orderId} (from ${slip.originalName})`,
                );
            }
        } catch (e) {
            console.error(`Error processing slip ${slip.originalName}:`, e);
            errors.push(`Error processing ${slip.originalName}: ${e.message}`);
        }
    }
    return { results, errors };
}

// Endpoint to scan default folder
app.get("/scan-default", async (req, res) => {
    try {
        if (!fs.existsSync(inputDir)) {
            // Return specific flag indicating config is needed
            return res.json({
                success: false,
                configNeeded: true,
                results: [],
                errors: [`Directory not found: ${inputDir}`],
            });
        }

        const files = await fsPromises.readdir(inputDir);
        const pdfFiles = files.filter((f) => f.toLowerCase().endsWith(".pdf"));

        if (pdfFiles.length === 0) {
            return res.json({
                success: true,
                results: [],
                errors: [],
                message: `No PDF files found in ${inputDir}`,
            });
        }

        const fileObjects = [];
        for (const file of pdfFiles) {
            const filePath = path.join(inputDir, file);
            const buffer = await fsPromises.readFile(filePath);
            fileObjects.push({
                originalName: file,
                buffer: buffer,
            });
        }

        const { results, errors } = await processFilePairs(fileObjects);

        res.json({
            success: true,
            results,
            errors,
            scannedDir: inputDir,
        });
    } catch (err) {
        console.error("Scan Error:", err);
        res.status(500).send("Scan Error: " + err.message);
    }
});

// API Endpoint to handle file upload and processing
app.post("/merge", upload.any(), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).send("No files uploaded.");
        }

        const isBulk = req.body.isBulk === "true";

        // Map multer files to our format
        const files = req.files.map((f) => ({
            originalName: f.originalname,
            buffer: f.buffer,
        }));

        let results = [];
        let errors = [];

        if (isBulk) {
            // BULK PROCESSING LOGIC
            if (files.length < 2) {
                return res
                    .status(400)
                    .send(
                        "Bulk processing requires at least 2 files (Labels & Slips).",
                    );
            }

            console.log("Starting Bulk Processing...");

            // 1. Identify which is Labels and which is Slips
            // Heuristic A: Try to extract Bulk Labels from the first file.
            // If we find IDs, assumes it's the Label file.
            let labelFile = null;
            let slipFile = null;
            let extractedLabels = [];

            // Try File 0 as Label File
            console.log(`Checking ${files[0].originalName} as Label File...`);
            let candidates = await extractBulkLabels(files[0].buffer);
            if (candidates.length > 0) {
                labelFile = files[0];
                slipFile = files[1];
                extractedLabels = candidates;
            } else {
                // Try File 1 as Label File
                console.log(
                    `Checking ${files[1].originalName} as Label File...`,
                );
                candidates = await extractBulkLabels(files[1].buffer);
                if (candidates.length > 0) {
                    labelFile = files[1];
                    slipFile = files[0];
                    extractedLabels = candidates;
                }
            }

            if (!labelFile) {
                return res
                    .status(400)
                    .send(
                        "Could not identify a Bulk Label file (2 labels/page with Order IDs).",
                    );
            }
            console.log(
                `Identified Label File: ${labelFile.originalName} (${extractedLabels.length} labels found)`,
            );

            // 2. Extract Slips from the other file
            console.log(`Extracting slips from ${slipFile.originalName}...`);
            const extractedSlips = await extractBulkSlips(
                slipFile.buffer,
                slipFile.originalName,
            );
            console.log(`Found ${extractedSlips.length} slips.`);

            // 3. Match and Process
            for (const slip of extractedSlips) {
                const orderId = slip.id;
                // Find matching label (Top or Bottom)
                const matchingLabel = extractedLabels.find(
                    (l) => l.id === orderId,
                );

                if (matchingLabel) {
                    console.log(`Match found for Order ${orderId}`);
                    try {
                        const output = await processLabels(
                            matchingLabel.buffer,
                            slip.buffer,
                            { 
                                isBulk: true,
                                position: matchingLabel.position || 'top' 
                            }
                        );
                        results.push({
                            filename: output.filename,
                            pdfBase64: Buffer.from(output.pdfBytes).toString(
                                "base64",
                            ),
                            metadata: output.metadata,
                        });
                    } catch (e) {
                        errors.push(
                            `Error merging Order ${orderId}: ${e.message}`,
                        );
                    }
                } else {
                    errors.push(`No label found for Order ID ${orderId}`);
                }
            }
        } else {
            // EXISTING LOGIC
            const outcome = await processFilePairs(files);
            results = outcome.results;
            errors = outcome.errors;
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
