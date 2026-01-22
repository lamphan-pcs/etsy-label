const pdfParse = require("pdf-parse");
const fs = require("fs");

console.log("Type of pdfParse:", typeof pdfParse);
console.log("pdfParse value:", pdfParse);

if (typeof pdfParse === "function") {
    console.log("It is a function.");
} else {
    console.log("It is NOT a function.");
}
