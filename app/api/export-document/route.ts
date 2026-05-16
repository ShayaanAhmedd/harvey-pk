// app/api/export-document/route.ts
//
// Legal Document Export API
//
// POST /api/export-document
//   Input:  { document: GeneratedLegalDocument, format: "docx" | "pdf" }
//   Output: Binary file download with correct Content-Type and Content-Disposition headers
//
// DOCX: built with the 'docx' npm library (Document, Packer, Paragraph, HeadingLevel)
// PDF:  built with 'pdfkit' (dynamic require to avoid ENOENT at boot)
//
// No LLM calls. No DB access. Pure formatting layer.

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
} from "docx";

import type { GeneratedLegalDocument } from "@/lib/ai/document-generator";

// ── Request shape ─────────────────────────────────────────────────────────────

interface ExportRequest {
  document: GeneratedLegalDocument;
  format: "docx" | "pdf";
}

// ── DOCX builder ──────────────────────────────────────────────────────────────

async function buildDocx(doc: GeneratedLegalDocument): Promise<Buffer> {
  const children: Paragraph[] = [];

  // ── Title ──
  children.push(
    new Paragraph({
      text: doc.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    })
  );

  // ── Sections ──
  for (const section of doc.sections) {
    const heading = String(section.heading ?? "");
    const content = String(section.content ?? "");

    // Section heading
    children.push(
      new Paragraph({
        text: heading,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 160 },
        border: {
          bottom: {
            color: "4B6BFB",
            size: 4,
            style: BorderStyle.SINGLE,
            space: 4,
          },
        },
      })
    );

    // Section content — split on newlines; blank lines become spacer paragraphs
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.trim() === "") {
        children.push(new Paragraph({ text: "", spacing: { after: 80 } }));
      } else {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: line,
                size: 22, // 11pt
                font: "Garamond",
              }),
            ],
            spacing: { after: 120 },
          })
        );
      }
    }
  }

  const wordDoc = new Document({
    styles: {
      paragraphStyles: [
        {
          id: "Normal",
          name: "Normal",
          run: { font: "Garamond", size: 22 },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, right: 1080, bottom: 1440, left: 1080 }, // 1" top/bottom, 0.75" sides
          },
        },
        children,
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(wordDoc));
}

// ── PDF builder ───────────────────────────────────────────────────────────────

async function buildPdf(doc: GeneratedLegalDocument): Promise<Buffer> {
  // Dynamic require to avoid ENOENT crash at module load time (same pattern as upload route)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const PDFDocument = require("pdfkit") as typeof import("pdfkit");

  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      margin: 72,       // 1 inch margins
      size: "A4",
      info: { Title: doc.title, Creator: "Harvey PK" },
    });

    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end",  () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    // ── Title ──
    pdf
      .font("Helvetica-Bold")
      .fontSize(18)
      .text(doc.title, { align: "center" })
      .moveDown(1.5);

    // ── Sections ──
    for (const section of doc.sections) {
      const heading = String(section.heading ?? "");
      const content = String(section.content ?? "");

      // Heading
      pdf
        .font("Helvetica-Bold")
        .fontSize(13)
        .text(heading, { align: "left" })
        .moveDown(0.2);

      // Underline the heading via a rule
      const x = pdf.page.margins.left;
      const w = pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
      const y = pdf.y;
      pdf.moveTo(x, y).lineTo(x + w, y).strokeColor("#4B6BFB").lineWidth(1).stroke().moveDown(0.4);
      pdf.strokeColor("black").lineWidth(1); // reset

      // Content
      pdf
        .font("Helvetica")
        .fontSize(10.5)
        .text(content, { align: "left", lineGap: 2 })
        .moveDown(1.2);
    }

    pdf.end();
  });
}

// ── Filename helpers ──────────────────────────────────────────────────────────

function safeFilename(title: string, ext: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug}.${ext}`;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: ExportRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { document: legalDoc, format } = body;

  if (!legalDoc || !legalDoc.title || !Array.isArray(legalDoc.sections)) {
    return NextResponse.json({ error: "Missing or invalid 'document' field" }, { status: 400 });
  }
  if (format !== "docx" && format !== "pdf") {
    return NextResponse.json({ error: "format must be 'docx' or 'pdf'" }, { status: 400 });
  }

  try {
    if (format === "docx") {
      const buffer = await buildDocx(legalDoc);
      const filename = safeFilename(legalDoc.title, "docx");

      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(buffer.length),
        },
      });
    } else {
      const buffer = await buildPdf(legalDoc);
      const filename = safeFilename(legalDoc.title, "pdf");

      return new NextResponse(buffer, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(buffer.length),
        },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Export failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
