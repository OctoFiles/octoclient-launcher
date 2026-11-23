/**
 * Loads a custom launcher background and compresses it before it is written to
 * the local config. Keeping the data URL small matters because the config is a
 * single JSON file, not a media folder.
 *
 * Animated GIFs are stored untouched: a canvas round-trip would keep only the
 * first frame, so those files are limited by size instead of being re-encoded.
 */

const MAX_EDGE = 1920;
const MAX_DATA_URL = 2_600_000;
const MAX_GIF_DATA_URL = 4_200_000;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Das Bild konnte nicht gelesen werden."));
    };
    image.src = url;
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Die Datei konnte nicht gelesen werden."));
    reader.readAsDataURL(file);
  });
}

export async function readBackgroundImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Bitte eine Bilddatei (PNG, JPG, WebP oder GIF) auswählen.");
  }

  if (file.type === "image/gif") {
    if (file.size > MAX_GIF_DATA_URL) {
      throw new Error(
        "Das GIF ist zu groß (maximal 4 MB). Bitte ein kleineres GIF wählen — Animation bleibt erhalten.",
      );
    }
    const dataUrl = await readAsDataUrl(file);
    if (dataUrl.length > MAX_GIF_DATA_URL * 1.4) {
      throw new Error("Das GIF ist zu groß für die Konfiguration. Bitte ein kleineres wählen.");
    }
    return dataUrl;
  }

  const image = await loadImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Das Bild konnte nicht verarbeitet werden.");

  // Opaque base so transparent PNGs do not turn black when saved as JPEG.
  context.fillStyle = "#070d18";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  let quality = 0.86;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > MAX_DATA_URL && quality > 0.42) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrl.length > MAX_DATA_URL) {
    throw new Error("Das Bild ist auch komprimiert zu groß. Bitte ein kleineres Bild wählen.");
  }
  return dataUrl;
}
