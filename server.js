const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs").promises;
const { exec } = require("child_process");
const {
    processLabels,
    extractLabelData,
    extractBulkLabels,
    extractBulkSlips,
    getIdsFromPdf,
    isSlip,
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

    // Classification with Content Check
    for (const f of fileObjects) {
        const detectedSlip = await isSlip(f.buffer);
        if (detectedSlip) {
            orderSlips.push(f);
        } else if (f.originalName.toLowerCase().includes("label")) {
            shippingLabels.push(f);
        } else {
            // Fallback: If not explicitly a slip, and filename doesn't say label.
            // Check if it MIGHT be a label?
            // For safety, previous logic defaulted to orderSlips.
            // But now we know explicit slips have the marker.
            // If it doesn't have the marker, it's increasingly likely to be the label (or a weird file).
            // Let's stick to the heuristic: if it has "slip" -> slip, else ?

            // If filenames are "Scan.pdf" (Label) and "Order.pdf" (Slip with marker).
            // Order.pdf -> detectedSlip=true -> orderSlips.
            // Scan.pdf -> detectedSlip=false. name no "label".
            // If we put Scan.pdf in orderSlips, we have 0 labels.
            // If we put Scan.pdf in shippingLabels, we might be right!

            // Heuristic change: If we already have explicit slips, maybe this is a label?
            // Let's assume if it is NOT a detected slip, treat as label potential?
            // "orderSlips" are loop drivers. "shippingLabels" are lookups.
            // If we misclassify a Slip as Label, we look up against it - no content match found usually.
            // If we misclassify a Label as Slip, we try to extract metadata from it - might succeed, then look for match in empty Label list.

            // For now, let's keep it simple: If it's NOT a detected Slip, and we haven't found a "label" keyword...
            // Checking content for "Tracking" or "USPS" might be better but let's just stick to what we know.
            if (f.originalName.toLowerCase().includes("slip")) {
                orderSlips.push(f);
            } else {
                // No "label", no "slip", no content marker.
                // Default to Slip (old behavior) or Label?
                orderSlips.push(f);
            }
        }
    }

    // Cache content IDs for labels to allow content-based processing
    // This avoids re-parsing the PDF for every slip
    const labelContentCache = new Map(); // filename -> [ids]
    for (const label of shippingLabels) {
        try {
            const ids = await getIdsFromPdf(label.buffer);
            labelContentCache.set(label.originalName, ids);
            if (ids.length > 0) {
                console.log(
                    `Pre-scanned ${label.originalName}: Found IDs ${ids.join(", ")}`,
                );
            }
        } catch (e) {
            console.warn(`Failed to pre-scan ${label.originalName}`);
        }
    }

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

            // 1. Try Filename Match
            let matchingLabel = shippingLabels.find((l) =>
                l.originalName.includes(orderId),
            );

            // 2. Try Content Match (if not found by filename)
            if (!matchingLabel) {
                for (const label of shippingLabels) {
                    const ids = labelContentCache.get(label.originalName);
                    if (ids && ids.includes(orderId)) {
                        matchingLabel = label;
                        console.log(
                            `Found content match for ${orderId} in ${label.originalName}`,
                        );
                        break;
                    }
                }
            }

            if (matchingLabel) {
                console.log(
                    `Found matching label: ${matchingLabel.originalName}`,
                );
                // processLabels now handles picking the right crop based on the slip's ID logic if we pass it,
                // or it re-extracts. Safe to just call it, but verify latest processor.js logic.
                // processor.js: "const slipMeta = await extractLabelData(label2Buffer);" -> It re-reads slip buffer to get targetID.
                // This is fine.
                const output = await processLabels(
                    matchingLabel.buffer,
                    slip.buffer,
                );

                // Determine the max file timestamp between the two source files
                const maxFileDate = Math.max(
                    slip.lastModified || 0,
                    matchingLabel.lastModified || 0,
                );

                results.push({
                    filename: output.filename,
                    pdfBase64: Buffer.from(output.pdfBytes).toString("base64"),
                    metadata: output.metadata,
                    fileDate: maxFileDate, // Pass back for secondary sorting/display
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
            const stats = await fsPromises.stat(filePath);

            fileObjects.push({
                originalName: file,
                buffer: buffer,
                lastModified: stats.mtimeMs, // Use server file modification time
            });
        }

        const { results, errors } = await processFilePairs(fileObjects);

        // --- SORTING LOGIC --- (Duplicate of /merge logic to ensure consistency)
        results.sort((a, b) => {
            // 1. Parse Metadata Date
            const parseDate = (dateStr) => {
                if (!dateStr || dateStr === "-") return 0;
                const d = new Date(dateStr);
                return isNaN(d.getTime()) ? 0 : d.getTime();
            };

            const dateA = parseDate(a.metadata.date);
            const dateB = parseDate(b.metadata.date);

            if (dateA !== dateB) {
                return dateB - dateA;
            }

            // 2. Secondary Sort: File Download Date
            const timeA = a.fileDate || 0;
            const timeB = b.fileDate || 0;
            return timeB - timeA;
        });

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

app.get("/pick-folder", (req, res) => {
    // PowerShell using OpenFileDialog hack to get a modern Explorer-style folder picker
    const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        $f = New-Object System.Windows.Forms.OpenFileDialog
        $f.ValidateNames = $false
        $f.CheckFileExists = $false
        $f.CheckPathExists = $true
        $f.FileName = "Select Folder"
        $f.Title = "Select Input Folder (Navigate inside and click Open)"
        $f.Filter = "Folders|*.none"
        if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
             $path = [System.IO.Path]::GetDirectoryName($f.FileName)
             Write-Output $path
        }
    `;

    // Encode as Base64 to safely pass complex scripts to PowerShell
    // PowerShell expects UTF-16LE encoding for Base64 strings
    const encodedScript = Buffer.from(psScript, "utf16le").toString("base64");
    
    // Run powershell with -EncodedCommand
    const command = `powershell -NoProfile -ExecutionPolicy Bypass -sta -EncodedCommand ${encodedScript}`;

    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error("Folder picker error:", error);
            console.error("Stderr:", stderr); 
            // Return the specific error to help debugging
            return res.json({ success: false, error: "Could not open dialog: " + stderr });
        }

        const selectedPath = stdout.trim();
        if (selectedPath) {
            res.json({ success: true, path: selectedPath });
        } else {
            res.json({ success: false, cancelled: true });
        }
    });
});

// API Endpoint to handle file upload and processing
app.post("/merge", upload.any(), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).send("No files uploaded.");
        }

        const isBulk = req.body.isBulk === "true";
        const fileDates = req.body.fileDates
            ? JSON.parse(req.body.fileDates)
            : {};

        // Map multer files to our format
        const files = req.files.map((f) => ({
            originalName: f.originalname,
            buffer: f.buffer,
            lastModified: fileDates[f.originalname] || 0,
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
                                position: matchingLabel.position || "top",
                            },
                        );

                        // Use the Slip File date as the "File Date" since bulk extraction separates them
                        // Ideally we'd map back to the original PDF date
                        const fileDate =
                            slipFile.lastModified ||
                            labelFile.lastModified ||
                            0;

                        results.push({
                            filename: output.filename,
                            pdfBase64: Buffer.from(output.pdfBytes).toString(
                                "base64",
                            ),
                            metadata: output.metadata,
                            fileDate: fileDate,
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

        // --- SORTING LOGIC ---
        // Sort by "Date Ordered" (Metadata) THEN by "Download Date" (File Timestamp)
        results.sort((a, b) => {
            // 1. Parse Metadata Date (MM/DD/YYYY)
            const parseDate = (dateStr) => {
                if (!dateStr || dateStr === "-") return 0;
                const d = new Date(dateStr);
                return isNaN(d.getTime()) ? 0 : d.getTime();
            };

            const dateA = parseDate(a.metadata.date);
            const dateB = parseDate(b.metadata.date);

            if (dateA !== dateB) {
                return dateB - dateA; // Descending (Latest first)
            }

            // 2. Secondary Sort: File Download Date
            const timeA = a.fileDate || 0;
            const timeB = b.fileDate || 0;
            return timeB - timeA; // Descending
        });

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
