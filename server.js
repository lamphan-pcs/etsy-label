const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs").promises;
const { exec } = require("child_process");
const {
    processLabels,
    processTikTokPair,
    processShopifyBulk,
    extractLabelData,
    extractBulkLabels,
    extractBulkSlips,
    getIdsFromPdf,
    isSlip,
    hasItemsText,
} = require("./src/processor");
require("dotenv").config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() }); // Store files in memory buffer

const PORT = process.env.PORT || 3000;
// Use INPUT_DIR from .env, or default to internal 'input' folder
let inputDir = process.env.INPUT_DIR || path.join(__dirname, "input");
let tiktokInputDir =
    process.env.TIKTOK_INPUT_DIR || process.env.INPUT_DIR || inputDir;
let outputDir = process.env.OUTPUT_DIR || inputDir;

console.log(`Scanning directory: ${inputDir}`);
console.log(`Scanning TikTok directory: ${tiktokInputDir}`);

// Serve static files from 'public' directory
app.use(express.static("public"));

async function updateEnvFileValue(key, newPath) {
    const envPath = path.join(__dirname, ".env");
    let envContent = "";
    try {
        envContent = await fsPromises.readFile(envPath, "utf8");
    } catch (err) {
        // File might not exist, create it
        envContent = "";
    }

    const newLine = `${key}=${newPath}`;
    const regex = new RegExp(`^${key}=.*`, "m");

    if (envContent.match(regex)) {
        envContent = envContent.replace(regex, newLine);
    } else {
        envContent += `\n${newLine}`;
    }

    await fsPromises.writeFile(envPath, envContent);
}

async function saveToOutputDir(filename, pdfBytes) {
    if (!outputDir) return false;
    try {
        const name = filename.endsWith(".pdf")
            ? filename.slice(0, -4)
            : filename;
        const filePath = path.join(outputDir, name);
        await fsPromises.writeFile(filePath, pdfBytes);
        return true;
    } catch (err) {
        console.error(`Failed to save ${filename} to output dir:`, err);
        return false;
    }
}

async function saveResultsToOutputDir(results) {
    if (!outputDir) return;
    for (const result of results) {
        if (result.pdfBase64) {
            const saved = await saveToOutputDir(
                result.filename,
                Buffer.from(result.pdfBase64, "base64"),
            );
            if (saved) result.savedLocally = true;
        }
    }
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
        await updateEnvFileValue("INPUT_DIR", newPath);
        inputDir = newPath;
        // Keep outputDir in sync if it was never explicitly set to something different
        if (!process.env.OUTPUT_DIR) {
            outputDir = newPath;
        }
        console.log(`Updated INPUT_DIR to: ${inputDir}`);
        res.json({ success: true, message: "Directory updated successfully" });
    } catch (err) {
        console.error("Failed to update env:", err);
        res.status(500).json({
            success: false,
            error: "Failed to save configuration",
        });
    }
});

app.post("/set-tiktok-input-dir", express.json(), async (req, res) => {
    const { path: newPath } = req.body;
    if (!newPath) {
        return res
            .status(400)
            .json({ success: false, error: "Path is required" });
    }

    if (!fs.existsSync(newPath)) {
        return res.status(400).json({
            success: false,
            error: "Directory does not exist on the server.",
        });
    }

    try {
        await updateEnvFileValue("TIKTOK_INPUT_DIR", newPath);
        tiktokInputDir = newPath;
        console.log(`Updated TIKTOK_INPUT_DIR to: ${tiktokInputDir}`);
        res.json({ success: true, message: "Directory updated successfully" });
    } catch (err) {
        console.error("Failed to update tiktok env:", err);
        res.status(500).json({
            success: false,
            error: "Failed to save configuration",
        });
    }
});

app.get("/get-output-dir", (req, res) => {
    res.json({ outputDir: outputDir || null });
});

app.post("/set-output-dir", express.json(), async (req, res) => {
    try {
        const { path: newPath, clear } = req.body || {};

        if (clear) {
            outputDir = inputDir;
            try {
                await updateEnvFileValue("OUTPUT_DIR", "");
            } catch (_) {}
            return res.json({
                success: true,
                message: "Output directory reset to input folder",
            });
        }

        if (!newPath) {
            return res
                .status(400)
                .json({ success: false, error: "Path is required" });
        }

        // Create the directory if it doesn't exist
        if (!fs.existsSync(newPath)) {
            try {
                fs.mkdirSync(newPath, { recursive: true });
            } catch (mkErr) {
                return res.status(400).json({
                    success: false,
                    error: `Could not create directory: ${mkErr.message}`,
                });
            }
        }

        await updateEnvFileValue("OUTPUT_DIR", newPath);
        outputDir = newPath;
        console.log(`Updated OUTPUT_DIR to: ${outputDir}`);
        res.json({
            success: true,
            message: "Output directory updated successfully",
        });
    } catch (err) {
        console.error("Failed to update output dir:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Helper function to check if output file exists
// Checks for both with and without .pdf extension since downloaded files may or may not have it
async function checkFileExists(filename) {
    return checkFileExistsInDir(filename, inputDir);
}

async function checkFileExistsInDir(filename, directory) {
    try {
        if (!directory) return false;

        // Check for exact filename (without extension)
        const filePath = path.join(directory, filename);
        if (fs.existsSync(filePath)) {
            return true;
        }

        // Check for filename with .pdf extension
        // (Windows sometimes adds this automatically when downloading)
        const filePathWithExt = path.join(directory, `${filename}.pdf`);
        if (fs.existsSync(filePathWithExt)) {
            return true;
        }

        return false;
    } catch (err) {
        console.warn(`Failed to check if file exists: ${filename}`, err);
        return false;
    }
}

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

                // Skip re-processing if the output file already exists in outputDir
                const predictedOutputPath = path.join(outputDir, orderId);
                if (fs.existsSync(predictedOutputPath)) {
                    console.log(`Skipping Order ${orderId} — already saved.`);
                    const maxFileDate = Math.max(
                        slip.lastModified || 0,
                        matchingLabel.lastModified || 0,
                    );
                    results.push({
                        filename: orderId,
                        pdfBase64: null,
                        metadata: { ...metadata, orderId },
                        fileDate: maxFileDate,
                        downloaded: true,
                        savedLocally: true,
                    });
                    continue;
                }

                const output = await processLabels(
                    matchingLabel.buffer,
                    slip.buffer,
                );

                // Determine the max file timestamp between the two source files
                const maxFileDate = Math.max(
                    slip.lastModified || 0,
                    matchingLabel.lastModified || 0,
                );

                // Check if output file already exists
                const fileExists = await checkFileExists(output.filename);

                results.push({
                    filename: output.filename,
                    pdfBase64: Buffer.from(output.pdfBytes).toString("base64"),
                    metadata: output.metadata,
                    fileDate: maxFileDate,
                    downloaded: fileExists,
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

async function processTikTokPairs(fileObjects, sourceDir = null) {
    const groups = new Map();
    const results = [];
    const errors = [];

    for (const f of fileObjects) {
        try {
            const ids = await getIdsFromPdf(f.buffer);
            const orderId = ids && ids.length > 0 ? ids[0] : null;

            if (!orderId) {
                errors.push(`No Order ID found in file: ${f.originalName}`);
                continue;
            }

            if (!groups.has(orderId)) {
                groups.set(orderId, []);
            }
            groups.get(orderId).push(f);
        } catch (e) {
            errors.push(`Failed to analyze ${f.originalName}: ${e.message}`);
        }
    }

    for (const [orderId, files] of groups.entries()) {
        if (files.length < 2) {
            errors.push(
                `Order ${orderId} has only ${files.length} file(s). Exactly 2 files are required per pair.`,
            );
            continue;
        }

        // Check which file contains "Items" (packing slip); shipping label goes first
        const fileInfos = await Promise.all(
            files.map(async (f) => ({
                file: f,
                isItems: await hasItemsText(f.buffer),
            })),
        );

        fileInfos.sort((a, b) => {
            if (a.isItems !== b.isItems) return a.isItems ? 1 : -1;
            return a.file.originalName.localeCompare(b.file.originalName);
        });

        if (fileInfos.length > 2) {
            errors.push(
                `Order ${orderId} has ${fileInfos.length} files. Processing the first 2 (label first, Items last).`,
            );
        }

        const file1 = fileInfos[0].file;
        const file2 = fileInfos[1].file;
        const maxFileDate = Math.max(
            file1.lastModified || 0,
            file2.lastModified || 0,
        );

        // Skip re-processing if already saved to outputDir
        const predictedTikTokPath = path.join(outputDir, orderId);
        if (fs.existsSync(predictedTikTokPath)) {
            console.log(`Skipping TikTok Order ${orderId} — already saved.`);
            results.push({
                filename: orderId,
                pdfBase64: null,
                metadata: { id: orderId, type: "tiktok", orderId },
                fileDate: maxFileDate,
                downloaded: true,
                savedLocally: true,
            });
            continue;
        }

        const output = await processTikTokPair(
            file1.buffer,
            file2.buffer,
            orderId,
        );
        const fileExists = sourceDir
            ? await checkFileExistsInDir(output.filename, sourceDir)
            : false;

        results.push({
            filename: output.filename,
            pdfBase64: Buffer.from(output.pdfBytes).toString("base64"),
            metadata: output.metadata,
            fileDate: maxFileDate,
            downloaded: fileExists,
        });
    }

    results.sort((a, b) => {
        const timeA = a.fileDate || 0;
        const timeB = b.fileDate || 0;
        return timeB - timeA;
    });

    return { results, errors };
}

async function processTikTokBulk(fileObjects) {
    const results = [];
    const errors = [];

    // 1. Classify: files with "Items" text are the bulk picking-slips; others are shipping labels
    const classified = await Promise.all(
        fileObjects.map(async (f) => ({
            file: f,
            isItems: await hasItemsText(f.buffer),
        })),
    );

    const slipsFiles = classified.filter((c) => c.isItems).map((c) => c.file);
    const labelFiles = classified.filter((c) => !c.isItems).map((c) => c.file);

    if (slipsFiles.length === 0) {
        return {
            results: [],
            errors: [
                'No bulk slips file detected. Ensure the picking-slips PDF contains the word "Items".',
            ],
        };
    }

    if (slipsFiles.length > 1) {
        errors.push(
            `Warning: ${slipsFiles.length} files contain "Items". Using "${slipsFiles[0].originalName}" as the bulk slips file.`,
        );
    }

    const bulkSlipsFile = slipsFiles[0];
    console.log(
        `TikTok Bulk: "${bulkSlipsFile.originalName}" as bulk slips, ${labelFiles.length} label file(s).`,
    );

    // 2. Split the bulk slips PDF into per-order slip buffers
    const extractedSlips = await extractBulkSlips(
        bulkSlipsFile.buffer,
        bulkSlipsFile.originalName,
    );

    if (extractedSlips.length === 0) {
        return {
            results: [],
            errors: [
                "Could not extract individual slips. Make sure Order IDs (Order #XXXX) are present in the text.",
            ],
        };
    }

    // 3. Pre-scan label files for their Order IDs
    const labelIdCache = new Map();
    for (const label of labelFiles) {
        try {
            const ids = await getIdsFromPdf(label.buffer);
            labelIdCache.set(label.originalName, ids);
            if (ids.length > 0) {
                console.log(
                    `Pre-scanned ${label.originalName}: IDs ${ids.join(", ")}`,
                );
            }
        } catch (e) {
            console.warn(`Failed to scan ${label.originalName}`);
        }
    }

    // 4. Match each slip to its shipping label and merge (label first, slip second)
    for (const slip of extractedSlips) {
        const orderId = slip.id;

        // Filename match first
        let matchedLabel = labelFiles.find((l) =>
            l.originalName.includes(orderId),
        );

        // Content match fallback
        if (!matchedLabel) {
            for (const label of labelFiles) {
                const ids = labelIdCache.get(label.originalName);
                if (ids && ids.includes(orderId)) {
                    matchedLabel = label;
                    break;
                }
            }
        }

        if (!matchedLabel) {
            errors.push(
                `No matching shipping label found for Order ${orderId}`,
            );
            continue;
        }

        try {
            const output = await processTikTokPair(
                matchedLabel.buffer,
                slip.buffer,
                orderId,
            );

            results.push({
                filename: output.filename,
                pdfBase64: Buffer.from(output.pdfBytes).toString("base64"),
                metadata: output.metadata,
                fileDate: Math.max(
                    matchedLabel.lastModified || 0,
                    bulkSlipsFile.lastModified || 0,
                ),
                downloaded: false,
            });
        } catch (e) {
            errors.push(`Error merging Order ${orderId}: ${e.message}`);
        }
    }

    results.sort((a, b) => (b.fileDate || 0) - (a.fileDate || 0));
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

        await saveResultsToOutputDir(results);
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

app.get("/scan-tiktok-default", async (req, res) => {
    try {
        if (!fs.existsSync(tiktokInputDir)) {
            return res.json({
                success: false,
                configNeeded: true,
                results: [],
                errors: [`Directory not found: ${tiktokInputDir}`],
            });
        }

        const files = await fsPromises.readdir(tiktokInputDir);
        const pdfFiles = files.filter((f) => f.toLowerCase().endsWith(".pdf"));

        if (pdfFiles.length === 0) {
            return res.json({
                success: true,
                results: [],
                errors: [],
                message: `No PDF files found in ${tiktokInputDir}`,
            });
        }

        const fileObjects = [];
        for (const file of pdfFiles) {
            const filePath = path.join(tiktokInputDir, file);
            const buffer = await fsPromises.readFile(filePath);
            const stats = await fsPromises.stat(filePath);

            fileObjects.push({
                originalName: file,
                buffer,
                lastModified: stats.mtimeMs,
            });
        }

        const { results, errors } = await processTikTokPairs(
            fileObjects,
            tiktokInputDir,
        );

        await saveResultsToOutputDir(results);
        res.json({
            success: true,
            results,
            errors,
            scannedDir: tiktokInputDir,
        });
    } catch (err) {
        console.error("TikTok scan error:", err);
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
            return res.json({
                success: false,
                error: "Could not open dialog: " + stderr,
            });
        }

        const selectedPath = stdout.trim();
        if (selectedPath) {
            res.json({ success: true, path: selectedPath });
        } else {
            res.json({ success: false, cancelled: true });
        }
    });
});

// Lightweight single-file analysis endpoint (Vercel-safe: one small file per request)
// Returns the file's type ('label' or 'slip') and order IDs extracted from it.
// The frontend calls this once per file, matches pairs client-side, then calls /merge per pair.
app.post("/analyze", upload.single("file"), async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: "No file provided" });
        }

        const detectedSlip = await isSlip(file.buffer);
        const type = detectedSlip ? "slip" : "label";
        let orderIds = [];

        if (type === "slip") {
            const meta = await extractLabelData(file.buffer);
            if (meta && meta.id) {
                orderIds = [meta.id];
            }
        } else {
            orderIds = await getIdsFromPdf(file.buffer);
        }

        res.json({ filename: file.originalname, type, orderIds });
    } catch (err) {
        console.error("Analyze error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/merge-tiktok-pairs", upload.any(), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).send("No files uploaded.");
        }

        const fileDates = req.body.fileDates
            ? JSON.parse(req.body.fileDates)
            : {};

        const files = req.files.map((f) => ({
            originalName: f.originalname,
            buffer: f.buffer,
            lastModified: fileDates[f.originalname] || 0,
        }));

        const { results, errors } = await processTikTokPairs(files);

        if (results.length === 0 && errors.length > 0) {
            return res
                .status(400)
                .send("Processing failed:\n" + errors.join("\n"));
        }

        await saveResultsToOutputDir(results);
        res.json({
            success: true,
            results,
            errors,
        });
    } catch (err) {
        console.error("TikTok merge error:", err);
        res.status(500).send("Server Error: " + err.message);
    }
});

app.post("/merge-tiktok-bulk", upload.any(), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).send("No files uploaded.");
        }

        const fileDates = req.body.fileDates
            ? JSON.parse(req.body.fileDates)
            : {};

        const files = req.files.map((f) => ({
            originalName: f.originalname,
            buffer: f.buffer,
            lastModified: fileDates[f.originalname] || 0,
        }));

        const { results, errors } = await processTikTokBulk(files);

        if (results.length === 0 && errors.length > 0) {
            return res
                .status(400)
                .send("Processing failed:\n" + errors.join("\n"));
        }

        await saveResultsToOutputDir(results);
        res.json({ success: true, results, errors });
    } catch (err) {
        console.error("TikTok bulk error:", err);
        res.status(500).send("Server Error: " + err.message);
    }
});

app.post("/merge-shopify-bulk", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send("No file uploaded.");
        }

        const { results, errors } = await processShopifyBulk(req.file.buffer);

        if (results.length === 0 && errors.length > 0) {
            return res
                .status(400)
                .send("Processing failed:\n" + errors.join("\n"));
        }

        await saveResultsToOutputDir(results);
        res.json({ success: true, results, errors });
    } catch (err) {
        console.error("Shopify bulk error:", err);
        res.status(500).send("Server Error: " + err.message);
    }
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

                        // Check if output file already exists
                        const fileExists = await checkFileExists(
                            output.filename,
                        );

                        results.push({
                            filename: output.filename,
                            pdfBase64: Buffer.from(output.pdfBytes).toString(
                                "base64",
                            ),
                            metadata: output.metadata,
                            fileDate: fileDate,
                            downloaded: fileExists,
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

        await saveResultsToOutputDir(results);
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
