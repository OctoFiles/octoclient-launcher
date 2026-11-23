import { useEffect, useRef } from "react";

import type { PerformanceMode } from "../../lib/types";
import "./galaxy.css";

interface GalaxyBackgroundProps {
  performance: PerformanceMode;
  reduceMotion: boolean;
  showParticles: boolean;
}

interface Preset {
  stars: number;
  twinkles: number;
  nebula: number;
  dpr: number;
  shooting: boolean;
  parallax: boolean;
}

const PRESETS: Record<PerformanceMode, Preset> = {
  high: { stars: 1050, twinkles: 90, nebula: 5, dpr: 2, shooting: true, parallax: true },
  balanced: { stars: 540, twinkles: 42, nebula: 4, dpr: 1.5, shooting: true, parallax: false },
  low: { stars: 210, twinkles: 0, nebula: 2, dpr: 1, shooting: false, parallax: false },
};

interface Twinkle {
  x: number;
  y: number;
  r: number;
  phase: number;
  speed: number;
  alpha: number;
}

interface ShootingStar {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

/** Deterministic PRNG so resizing does not reshuffle the sky. */
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawPlanet(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  // Ambient glow.
  const glow = ctx.createRadialGradient(x, y, radius * 0.7, x, y, radius * 2.3);
  glow.addColorStop(0, "rgba(94, 234, 212, 0.12)");
  glow.addColorStop(0.55, "rgba(96, 165, 250, 0.05)");
  glow.addColorStop(1, "rgba(96, 165, 250, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, radius * 2.3, 0, Math.PI * 2);
  ctx.fill();

  const ring = () => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.32);
    ctx.scale(1, 0.26);
    ctx.lineWidth = radius * 0.14;
    ctx.strokeStyle = "rgba(148, 205, 235, 0.24)";
    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = radius * 0.035;
    ctx.strokeStyle = "rgba(190, 235, 255, 0.22)";
    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.78, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };

  // Back half of the ring.
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.32);
  ctx.scale(1, 0.26);
  ctx.lineWidth = radius * 0.14;
  ctx.strokeStyle = "rgba(148, 205, 235, 0.16)";
  ctx.beginPath();
  ctx.arc(0, 0, radius * 1.6, Math.PI, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Planet body.
  const sphere = ctx.createRadialGradient(
    x - radius * 0.35,
    y - radius * 0.4,
    radius * 0.08,
    x,
    y,
    radius,
  );
  sphere.addColorStop(0, "#16384a");
  sphere.addColorStop(0.45, "#0d2335");
  sphere.addColorStop(1, "#03070d");
  ctx.fillStyle = sphere;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  // Cloud bands.
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalAlpha = 0.16;
  for (let index = 0; index < 4; index += 1) {
    ctx.fillStyle = index % 2 === 0 ? "#2c5f74" : "#0a1a28";
    ctx.beginPath();
    ctx.ellipse(
      x,
      y - radius * 0.55 + index * radius * 0.36,
      radius * 1.1,
      radius * 0.09,
      -0.18,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();

  // Rim light.
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = "rgba(110, 231, 249, 0.7)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(x, y, radius - 0.5, Math.PI * 0.66, Math.PI * 1.75);
  ctx.stroke();
  ctx.restore();

  ring();
}

function paintStatic(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  preset: Preset,
  showParticles: boolean,
): Twinkle[] {
  const random = mulberry32(0xf2057);
  const scale = Math.max(width, height) / 1280;

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  const base = ctx.createLinearGradient(0, 0, width * 0.6, height);
  base.addColorStop(0, "#01030a");
  base.addColorStop(0.55, "#02040b");
  base.addColorStop(1, "#04060e");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  // Nebula clouds.
  for (let index = 0; index < preset.nebula; index += 1) {
    const x = random() * width;
    const y = random() * height * 0.9;
    const radius = Math.max(width, height) * (0.14 + random() * 0.16);
    const hue = index % 2 === 0 ? 192 : 262;
    const cloud = ctx.createRadialGradient(x, y, 0, x, y, radius);
    cloud.addColorStop(0, `hsla(${hue}, 82%, 58%, 0.10)`);
    cloud.addColorStop(0.55, `hsla(${hue}, 76%, 52%, 0.04)`);
    cloud.addColorStop(1, `hsla(${hue}, 76%, 52%, 0)`);
    ctx.fillStyle = cloud;
    ctx.fillRect(0, 0, width, height);
  }

  // Milky Way band.
  ctx.save();
  ctx.translate(width * 0.5, height * 0.62);
  ctx.rotate(-0.42);
  const band = ctx.createLinearGradient(0, -height * 0.2, 0, height * 0.2);
  band.addColorStop(0, "rgba(96, 165, 250, 0)");
  band.addColorStop(0.45, "rgba(110, 130, 246, 0.09)");
  band.addColorStop(0.6, "rgba(160, 120, 246, 0.07)");
  band.addColorStop(1, "rgba(96, 165, 250, 0)");
  ctx.fillStyle = band;
  ctx.fillRect(-width, -height * 0.2, width * 2, height * 0.4);

  // Dust concentrated along the band.
  const dust = Math.round(preset.stars * 0.5);
  for (let index = 0; index < dust; index += 1) {
    const x = (random() - 0.5) * width * 1.9;
    const spread = (random() + random() + random() - 1.5) * height * 0.075;
    const alpha = 0.05 + random() * 0.35;
    ctx.fillStyle = `rgba(214, 235, 255, ${alpha})`;
    ctx.fillRect(x, spread, 0.9 * scale + 0.4, 0.9 * scale + 0.4);
  }
  ctx.restore();

  // Field stars + twinkling subset.
  const twinkles: Twinkle[] = [];
  const twinkleCount = showParticles ? preset.twinkles : 0;
  for (let index = 0; index < preset.stars; index += 1) {
    const x = random() * width;
    const y = random() * height;
    const size = (random() < 0.88 ? 0.8 : 1.4) * scale + random() * 0.6;
    const alpha = 0.18 + random() * 0.6;
    const hue = random() < 0.12 ? 190 : random() < 0.1 ? 268 : null;
    ctx.fillStyle = hue
      ? `hsla(${hue}, 85%, 82%, ${alpha})`
      : `rgba(226, 240, 255, ${alpha})`;
    if (size < 1.1) {
      ctx.fillRect(x, y, size, size);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, size * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    if (twinkles.length < twinkleCount && random() < twinkleCount / preset.stars / 2.2) {
      twinkles.push({
        x,
        y,
        r: 0.9 * scale + 0.6,
        phase: random() * Math.PI * 2,
        speed: 0.6 + random() * 1.8,
        alpha: 0.35 + random() * 0.55,
      });
    }
  }

  drawPlanet(ctx, width * 0.79, height * 0.2, Math.min(width, height) * 0.185);
  return twinkles;
}

export function GalaxyBackground({
  performance,
  reduceMotion,
  showParticles,
}: GalaxyBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const preset = PRESETS[performance];
    const motion = !reduceMotion;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let staticCanvas = document.createElement("canvas");
    let twinkles: Twinkle[] = [];
    let shooting: ShootingStar[] = [];
    // `performance` is also a prop name, so use the global explicitly.
    const nowMs = () => globalThis.performance.now();
    let raf = 0;
    let lastFrame = nowMs();
    let lastSpawn = nowMs();
    let nextSpawnDelay = 2600;
    const mouse = { x: 0.5, y: 0.5 };
    const target = { x: 0.5, y: 0.5 };

    const draw = (now: number) => {
      const time = now / 1000;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const parallax = preset.parallax && motion ? 1 : 0;
      const scale = 1.05;
      const dx = -(mouse.x - 0.5) * 16 * parallax - (width * (scale - 1)) / 2;
      const dy = -(mouse.y - 0.5) * 12 * parallax - (height * (scale - 1)) / 2;
      ctx.drawImage(staticCanvas, dx, dy, width * scale, height * scale);

      if (motion) {
        for (const twinkle of twinkles) {
          const alpha =
            0.2 + 0.8 * (0.5 + 0.5 * Math.sin(time * twinkle.speed + twinkle.phase));
          ctx.fillStyle = `rgba(228, 245, 255, ${(alpha * twinkle.alpha).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(twinkle.x, twinkle.y, twinkle.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (motion && showParticles && preset.shooting) {
        if (now - lastSpawn > nextSpawnDelay) {
          const startX = width * (0.1 + Math.random() * 0.65);
          const startY = height * (0.05 + Math.random() * 0.3);
          const speed = 520 + Math.random() * 320;
          const angle = 0.45 + Math.random() * 0.3;
          shooting.push({
            x: startX,
            y: startY,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 1,
            maxLife: 1,
          });
          lastSpawn = now;
          nextSpawnDelay = 3200 + Math.random() * 5200;
        }

        const dt = Math.min(0.05, (now - lastFrame) / 1000);
        shooting = shooting.filter((star) => {
          star.x += star.vx * dt;
          star.y += star.vy * dt;
          star.life -= dt * 0.85;
          if (star.life <= 0) return false;

          const tailX = star.x - star.vx * 0.13;
          const tailY = star.y - star.vy * 0.13;
          const gradient = ctx.createLinearGradient(star.x, star.y, tailX, tailY);
          gradient.addColorStop(0, `rgba(214, 246, 255, ${0.85 * star.life})`);
          gradient.addColorStop(1, "rgba(160, 220, 255, 0)");
          ctx.strokeStyle = gradient;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(star.x, star.y);
          ctx.lineTo(tailX, tailY);
          ctx.stroke();

          ctx.fillStyle = `rgba(240, 252, 255, ${0.9 * star.life})`;
          ctx.beginPath();
          ctx.arc(star.x, star.y, 1.4, 0, Math.PI * 2);
          ctx.fill();
          return true;
        });
      }
      lastFrame = now;
    };

    const build = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, preset.dpr);
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      staticCanvas = document.createElement("canvas");
      staticCanvas.width = canvas.width;
      staticCanvas.height = canvas.height;
      const staticCtx = staticCanvas.getContext("2d");
      if (!staticCtx) return;
      staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      twinkles = paintStatic(staticCtx, width, height, preset, showParticles);
      draw(nowMs());
    };

    const loop = (now: number) => {
      raf = window.requestAnimationFrame(loop);
      if (document.hidden) return;
      mouse.x += (target.x - mouse.x) * 0.04;
      mouse.y += (target.y - mouse.y) * 0.04;
      draw(now);
    };

    const onPointerMove = (event: PointerEvent) => {
      target.x = event.clientX / Math.max(1, window.innerWidth);
      target.y = event.clientY / Math.max(1, window.innerHeight);
    };

    let resizeTimer: number | undefined;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(build, 140);
    };

    build();
    window.addEventListener("resize", onResize);
    if (preset.parallax && motion) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
    }
    if (motion) {
      lastFrame = nowMs();
      raf = window.requestAnimationFrame(loop);
    }

    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      if (staticCanvas) staticCanvas.width = 0;
    };
  }, [performance, reduceMotion, showParticles]);

  return (
    <div className="galaxy" aria-hidden="true">
      <canvas ref={canvasRef} />
      <div className="galaxy__vignette" />
      <div className="galaxy__grain" />
    </div>
  );
}
