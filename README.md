# Etsy Label Merger

A simple web tool to combine shipping labels. It allows you to drag and drop two PDF labels, processes them (crops/rotates one, keeps the other), and returns a single combined PDF.

## Features
- **Drag & Drop Interface**: Simple web UI to upload files.
- **Label Processing**:
    - **Label 1**: Cropped (fixed area) and Rotated (90 degrees).
    - **Label 2**: Appended as-is.
- **Privacy**: Processing happens locally on your machine.

## Setup

1.  **Install Node.js**: Ensure you have Node.js installed.
2.  **Install Dependencies**:
    ```bash
    npm install
    ```

## Usage

1.  **Start the Server**:
    ```bash
    node server.js
    ```
    *(Or usage `npm start` if configured)*

2.  **Open Browser**:
    - Go to [http://localhost:3000](http://localhost:3000).

3.  **Process Labels**:
    - Drag **Label 1** (the one needing crop/rotate) into the first box.
    - Drag **Label 2** (the standard one) into the second box.
    - Click **Process & Download**.

## Customization

- **Crop Area**: Edit `src/processor.js` to adjust the `setCropBox` dimensions.

