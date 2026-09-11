// Thin QR-code rendering helper built on the vendored encoder in
// ./vendor/qrcodegen.ts (Project Nayuki's qrcodegen, MIT-licensed).
import { Ecc, QrCode } from "./vendor/qrcodegen";

export interface QrSvgOptions {
  /** Quiet-zone width in modules. Default 4 (the minimum recommended by the QR spec). */
  border?: number;
  /** Fill for dark modules. Default "currentColor" so the code follows the page's text color. */
  foreground?: string;
  /** Fill for the background, or "none" for a transparent background. Default "none". */
  background?: string;
}

/**
 * Encodes `text` as a QR code and returns a self-contained SVG markup string.
 * The SVG's viewBox is sized to the module grid (including the quiet zone),
 * so it scales cleanly to any container size via CSS.
 */
export function qrCodeToSvgString(text: string, opts: QrSvgOptions = {}): string {
  const border = opts.border ?? 4;
  const foreground = opts.foreground ?? "currentColor";
  const background = opts.background ?? "none";

  // LOW error correction keeps the module count down for the fairly long
  // URLs this page generates, which keeps the printed/scanned code smaller.
  const qr = QrCode.encodeText(text, Ecc.LOW);
  const size = qr.size + border * 2;

  let path = "";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) {
        path += `M${x + border},${y + border}h1v1h-1z`;
      }
    }
  }

  const bg = background === "none" ? "" : `<rect width="${size}" height="${size}" fill="${background}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `role="img" aria-label="QR code for the widget URL">${bg}` +
    `<path d="${path}" fill="${foreground}"/></svg>`
  );
}

/** Renders a QR code for `text` into `container`, replacing any existing content. */
export function renderQrCode(container: HTMLElement, text: string, opts: QrSvgOptions = {}): void {
  container.innerHTML = qrCodeToSvgString(text, opts);
}
