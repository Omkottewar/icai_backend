// Attendance / CPE certificate PDF generator.
//
// Generates a single-page A4 landscape PDF that the user downloads from
// /api/events/:slug/certificate. Layout is intentionally simple — branch
// title at top, name and event details in the centre, CPE hours + date
// + signature blocks at bottom. No external image assets required.
//
// Notification S.6 ("Certificate ready for download") points the user
// straight at this endpoint, so the URL is the canonical certificate
// permalink. Regenerating it on every request keeps storage simple.

import PDFDocument from "pdfkit";
import type { Writable } from "node:stream";

export interface CertificateInput {
  memberName: string;
  memberMrn: string | null;
  eventTitle: string;
  eventDate: Date;          // event.starts_at
  cpeHours: number;
  branchName: string;       // "Nagpur Branch of WIRC of ICAI"
  certificateNo: string;    // e.g. "NGP-CPE-{event.slug.slice(-8)}-{userId.slice(0,8)}"
}

const IST_DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "long",
  year: "numeric",
});

const ISSUED_DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

/**
 * Stream a generated certificate PDF into `out`.
 * Caller is responsible for setting Content-Type / Disposition headers.
 */
export function streamCertificate(input: CertificateInput, out: Writable): void {
  // A4 landscape: 842 × 595 points (72 dpi).
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 40, bottom: 40, left: 60, right: 60 },
  });
  doc.pipe(out);

  const W = doc.page.width;
  const H = doc.page.height;

  // ─── Decorative double border ─────────────────────────────────────────
  doc.lineWidth(2).strokeColor("#0f172a")
    .rect(24, 24, W - 48, H - 48).stroke();
  doc.lineWidth(0.5)
    .rect(36, 36, W - 72, H - 72).stroke();

  // ─── Header ──────────────────────────────────────────────────────────
  doc.fillColor("#475569")
    .fontSize(10)
    .font("Helvetica")
    .text("THE INSTITUTE OF CHARTERED ACCOUNTANTS OF INDIA", 0, 70, {
      align: "center",
      width: W,
      characterSpacing: 2,
    });

  doc.moveDown(0.3)
    .fillColor("#0f172a")
    .fontSize(14)
    .font("Helvetica-Bold")
    .text(input.branchName, 0, doc.y, {
      align: "center",
      width: W,
    });

  // ─── Title ───────────────────────────────────────────────────────────
  doc.moveDown(1.5)
    .fillColor("#0f172a")
    .fontSize(32)
    .font("Helvetica-Bold")
    .text("CERTIFICATE OF PARTICIPATION", 0, doc.y, {
      align: "center",
      width: W,
    });

  // Short underline
  const titleBottom = doc.y + 6;
  doc.lineWidth(1).strokeColor("#0f172a")
    .moveTo(W / 2 - 80, titleBottom).lineTo(W / 2 + 80, titleBottom).stroke();

  // ─── Body ────────────────────────────────────────────────────────────
  doc.moveDown(2.2)
    .fillColor("#334155")
    .fontSize(13)
    .font("Helvetica")
    .text("This is to certify that", 0, doc.y, { align: "center", width: W });

  doc.moveDown(0.5)
    .fillColor("#0f172a")
    .fontSize(26)
    .font("Helvetica-Bold")
    .text(input.memberName, 0, doc.y, { align: "center", width: W });

  if (input.memberMrn) {
    doc.moveDown(0.2)
      .fillColor("#64748b")
      .fontSize(11)
      .font("Helvetica")
      .text(`MRN: ${input.memberMrn}`, 0, doc.y, { align: "center", width: W });
  }

  doc.moveDown(1.0)
    .fillColor("#334155")
    .fontSize(13)
    .font("Helvetica")
    .text("has attended the programme", 0, doc.y, { align: "center", width: W });

  doc.moveDown(0.5)
    .fillColor("#0f172a")
    .fontSize(18)
    .font("Helvetica-Bold")
    .text(input.eventTitle, 0, doc.y, { align: "center", width: W });

  doc.moveDown(0.5)
    .fillColor("#475569")
    .fontSize(12)
    .font("Helvetica")
    .text(
      `held on ${IST_DATE.format(input.eventDate)} and is awarded ${input.cpeHours} CPE hour${input.cpeHours === 1 ? "" : "s"}.`,
      0, doc.y, { align: "center", width: W }
    );

  // ─── Footer — signature blocks + cert metadata ───────────────────────
  const footerY = H - 120;
  const sigBlockWidth = 220;

  // Left signature: Chairman
  doc.lineWidth(0.7).strokeColor("#0f172a")
    .moveTo(80, footerY).lineTo(80 + sigBlockWidth, footerY).stroke();
  doc.fillColor("#0f172a")
    .fontSize(10).font("Helvetica-Bold")
    .text("Chairperson", 80, footerY + 6, { width: sigBlockWidth, align: "center" });
  doc.fillColor("#64748b").font("Helvetica").fontSize(9)
    .text(input.branchName, 80, footerY + 20, { width: sigBlockWidth, align: "center" });

  // Right signature: Branch
  doc.lineWidth(0.7).strokeColor("#0f172a")
    .moveTo(W - 80 - sigBlockWidth, footerY).lineTo(W - 80, footerY).stroke();
  doc.fillColor("#0f172a")
    .fontSize(10).font("Helvetica-Bold")
    .text("Secretary", W - 80 - sigBlockWidth, footerY + 6, { width: sigBlockWidth, align: "center" });
  doc.fillColor("#64748b").font("Helvetica").fontSize(9)
    .text(input.branchName, W - 80 - sigBlockWidth, footerY + 20, { width: sigBlockWidth, align: "center" });

  // Cert no + issued date in the centre
  doc.fillColor("#94a3b8").fontSize(9).font("Helvetica")
    .text(`Certificate No: ${input.certificateNo}`, 0, footerY + 12, { width: W, align: "center" })
    .text(`Issued: ${ISSUED_DATE.format(new Date())}`, 0, footerY + 26, { width: W, align: "center" });

  doc.end();
}
