// lib/utils/ocr.ts
//
// Pure Node.js OCR fallback for scanned PDFs.
// No system binaries required (no Ghostscript, no GraphicsMagick).
//
// Pipeline:
//   pdfBuffer
//   → pdfjs-dist  (parse PDF, render each page to a node-canvas)
//   → canvas.toBuffer("image/png")
//   → tesseract.js  (OCR on the PNG buffer)
//   → concatenated text
//
// npm dependencies:
//   pdfjs-dist       — pure-JS PDF parser + renderer
//   @napi-rs/canvas  — prebuilt canvas binaries (no libcairo/GTK required)
//   tesseract.js     — pure-JS OCR
//
// IMPORTANT: pdfjs-dist@3 only ships pdf.js (CJS) in the legacy build — no .mjs.
// The "canvas" auto-require is suppressed at the Next.js bundler level via
// serverExternalPackages in next.config.ts.

export async function extractTextWithOCR(pdfBuffer: Buffer): Promise<string> {
  // Dynamic requires keep heavy native modules out of the module-level bundle
  // and prevent import errors when OCR is not being used.

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createCanvas } = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.js") as typeof import("pdfjs-dist");

  // pdfjs needs a worker — in Node.js legacy mode the worker is disabled.
  pdfjsLib.GlobalWorkerOptions.workerSrc = "";

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Tesseract = require("tesseract.js") as typeof import("tesseract.js");

  // ── Load PDF document ──────────────────────────────────────────────────────
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) });
  const pdfDoc = await loadingTask.promise;

  const pageTexts: string[] = [];

  // ── Process each page ──────────────────────────────────────────────────────
  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    try {
      const page     = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 }); // scale 2× for better OCR accuracy

      const canvas  = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext("2d");

      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;

      const imageBuffer = canvas.toBuffer("image/png");

      const { data: { text } } = await Tesseract.recognize(imageBuffer, "eng");
      if (text.trim()) pageTexts.push(text.trim());
    } catch (err) {
      console.warn(`[OCR] page ${pageNum}/${pdfDoc.numPages} failed:`, err);
      // Continue with remaining pages rather than aborting the whole document
    }
  }

  return pageTexts.join("\n\n");
}
