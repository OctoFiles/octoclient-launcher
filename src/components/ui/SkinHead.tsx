import { useEffect, useMemo, useState } from "react";

import {
  canonicalSkinDataUrl,
  getSkin,
  skinDataUrl,
} from "../../features/play/minecraft/skin";

interface SkinHeadProps {
  skinId: string;
  /** Real skin from the signed-in account, when available. */
  skinDataUrlSrc?: string | null;
  size?: number;
  className?: string;
}

/**
 * Renders the 8×8 face (plus hat overlay) from a 64×64 skin, scaled with
 * nearest-neighbour sampling so the pixels stay crisp.
 */
export function SkinHead({ skinId, skinDataUrlSrc, size = 32, className }: SkinHeadProps) {
  const rawUrl = useMemo(
    () => skinDataUrlSrc ?? skinDataUrl(getSkin(skinId).id),
    [skinDataUrlSrc, skinId],
  );
  // Microsoft skins can be 128x128 or legacy 64x32; normalise them to the
  // 64x64 grid this component crops its face regions from.
  const [url, setUrl] = useState(rawUrl);
  useEffect(() => {
    let alive = true;
    setUrl(rawUrl);
    canonicalSkinDataUrl(rawUrl)
      .then((normalized) => {
        if (alive) setUrl(normalized);
      })
      .catch(() => {
        /* keep the unnormalised image as a fallback */
      });
    return () => {
      alive = false;
    };
  }, [rawUrl]);
  // The face is laid out on the skin's native 64×64 grid and scaled with a
  // transform. Sizing the background instead (64 × size/8) lands on fractional
  // pixels for sizes like 26 or 34 px and clips the last texel row/column — the
  // "missing corner" that made the avatar look broken.
  const scale = size / 8;

  return (
    <span
      className={["skin-head", className].filter(Boolean).join(" ")}
      style={{ width: size, height: size, ["--head-scale" as string]: scale }}
      aria-hidden="true"
    >
      <span
        className="skin-head__layer"
        style={{
          backgroundImage: `url(${url})`,
          backgroundSize: "64px 64px",
          backgroundPosition: "-8px -8px",
        }}
      />
      <span
        className="skin-head__layer"
        style={{
          backgroundImage: `url(${url})`,
          backgroundSize: "64px 64px",
          backgroundPosition: "-40px -8px",
        }}
      />
    </span>
  );
}
