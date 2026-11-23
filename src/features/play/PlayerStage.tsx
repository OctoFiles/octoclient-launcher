import { useEffect, useRef } from "react";
import * as THREE from "three";

import type { PerformanceMode, SkinModel } from "../../lib/types";
import { createPlayer } from "./minecraft/player";

interface PlayerStageProps {
  skinId: string;
  skinModel: SkinModel;
  capeId: string;
  accessoryId: string;
  headId: string;
  bandanaId: string;
  wingId: string;
  shieldId: string;
  /** 64×64 skin PNG from the signed-in Microsoft account (data URL). */
  skinDataUrlSrc?: string | null;
  name: string;
  performance: PerformanceMode;
  reduceMotion?: boolean;
  showNameTag?: boolean;
  interactive?: boolean;
  className?: string;
}

/**
 * 3D stage: character, lighting and a DOM name tag projected onto the head.
 * The renderer is created once per skin/cape/performance combination and fully
 * disposed on unmount.
 */
export function PlayerStage({
  skinId,
  skinModel,
  capeId,
  accessoryId,
  headId,
  bandanaId,
  wingId,
  shieldId,
  skinDataUrlSrc,
  name,
  performance,
  reduceMotion = false,
  showNameTag = true,
  interactive = true,
  className,
}: PlayerStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tagRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const low = performance === "low";
    // `performance` is a prop name; use the global timer explicitly.
    const nowMs = () => globalThis.performance.now();
    let disposed = false;
    let frame = 0;
    let previous = nowMs();
    let lastRender = 0;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: !low,
      powerPreference: "high-performance",
    });
    renderer.setClearAlpha(0);
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, low ? 1 : performance === "high" ? 2 : 1.5),
    );

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 40);
    camera.position.set(0, 1.16, 4);
    camera.lookAt(0, 1.02, 0);

    scene.add(new THREE.HemisphereLight(0xdff1ff, 0x0a1018, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.25);
    key.position.set(2.5, 4.2, 3.2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x7dd3fc, 1.1);
    rim.position.set(-2.6, 2.6, -3.2);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0x8b7cf6, 0.5);
    fill.position.set(-3, 1.2, 2.4);
    scene.add(fill);

    const player = createPlayer({
      skinId,
      skinModel,
      skinDataUrl: skinDataUrlSrc,
      capeId,
      accessoryId,
      headId,
      bandanaId,
      wingId,
      shieldId,
    });
    scene.add(player.root);

    if (import.meta.env.DEV) {
      (window as unknown as { __frostStage?: unknown }).__frostStage = {
        player,
        camera,
        scene,
        renderer,
      };
    }

    const pointer = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };
    // Mouse-wheel zoom: the camera slides along its view axis, so the character
    // shrinks or grows without moving out of frame.
    const baseDistance = 4;
    let distance = baseDistance;
    const projected = new THREE.Vector3();
    // Body rotation controlled by dragging horizontally (±180°).
    let yaw = -0.32;
    let dragging = false;
    let dragStartX = 0;

    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    // Hats and crowns need a little more room above the head.
    const tagHeight = headId === "none" ? 2.16 : 2.58;

    const positionNameTag = () => {
      const tag = tagRef.current;
      if (!tag) return;
      projected.set(0, tagHeight, 0);
      player.root.localToWorld(projected);
      projected.project(camera);
      const width = host.clientWidth;
      const height = host.clientHeight;
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (projected.y * -0.5 + 0.5) * height;
      tag.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
      tag.style.opacity = projected.z > 1 ? "0" : "1";
    };

    const paint = (time: number, delta: number) => {
      player.update(time, delta, pointer, yaw);
      renderer.render(scene, camera);
      positionNameTag();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!interactive) return;
      dragging = true;
      dragStartX = event.clientX;
      host.classList.add("player-stage--dragging");
      try {
        host.setPointerCapture(event.pointerId);
      } catch {
        /* pointer capture is optional */
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!interactive) return;
      const rect = host.getBoundingClientRect();
      target.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      target.y = ((event.clientY - rect.top) / rect.height) * 2 - 1;

      if (dragging) {
        yaw += (event.clientX - dragStartX) * 0.012;
        yaw = Math.max(-Math.PI, Math.min(Math.PI, yaw));
        dragStartX = event.clientX;
        // Exposed for debugging and for future UI (e.g. a cape turntable).
        host.dataset.yaw = yaw.toFixed(3);
        if (reduceMotion) paint(0, 0.016);
      }
    };

    const endDrag = (event: PointerEvent) => {
      dragging = false;
      host.classList.remove("player-stage--dragging");
      try {
        host.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    };

    const resetPointer = () => {
      target.x = 0;
      target.y = 0;
    };

    const applyDistance = () => {
      camera.position.set(0, 1.16 + (distance - baseDistance) * 0.18, distance);
      camera.updateProjectionMatrix();
    };

    const onWheel = (event: WheelEvent) => {
      if (!interactive) return;
      event.preventDefault();
      const step = event.deltaY > 0 ? 0.4 : -0.4;
      distance = Math.max(1.9, Math.min(8, distance + step));
      applyDistance();
      host.dataset.zoom = (baseDistance / distance).toFixed(2);
      if (reduceMotion) paint(0, 0.016);
    };

    // Double click restores the default framing.
    const onDoubleClick = () => {
      if (!interactive) return;
      distance = baseDistance;
      yaw = -0.32;
      applyDistance();
      host.dataset.zoom = "1.00";
      if (reduceMotion) paint(0, 0.016);
    };

    if (interactive) {
      host.addEventListener("pointerdown", onPointerDown);
      host.addEventListener("pointermove", onPointerMove);
      host.addEventListener("pointerup", endDrag);
      host.addEventListener("pointercancel", endDrag);
      host.addEventListener("pointerleave", resetPointer);
      host.addEventListener("wheel", onWheel, { passive: false });
      host.addEventListener("dblclick", onDoubleClick);
    }

    resize();
    const observer = new ResizeObserver(() => {
      resize();
      if (reduceMotion) paint(0, 0.016);
    });
    observer.observe(host);

    const loop = (now: number) => {
      if (disposed) return;
      frame = window.requestAnimationFrame(loop);
      if (document.hidden) return;
      if (low && now - lastRender < 32) return;
      lastRender = now;
      const delta = Math.min(0.05, Math.max(0.001, (now - previous) / 1000));
      previous = now;
      pointer.x += (target.x - pointer.x) * 0.07;
      pointer.y += (target.y - pointer.y) * 0.07;
      paint(previous / 1000, delta);
    };

    if (reduceMotion) {
      paint(0, 0.016);
    } else {
      frame = window.requestAnimationFrame(loop);
    }

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", endDrag);
      host.removeEventListener("pointercancel", endDrag);
      host.removeEventListener("pointerleave", resetPointer);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("dblclick", onDoubleClick);
      player.dispose();
      renderer.dispose();
      scene.clear();
    };
  }, [
    skinId,
    skinModel,
    capeId,
    accessoryId,
    headId,
    bandanaId,
    wingId,
    shieldId,
    skinDataUrlSrc,
    performance,
    reduceMotion,
    showNameTag,
    interactive,
  ]);

  return (
    <div
      ref={hostRef}
      className={["player-stage", className].filter(Boolean).join(" ")}
    >
      <div className="player-stage__glow" aria-hidden="true" />
      <canvas ref={canvasRef} className="player-stage__canvas" />
      {showNameTag ? (
        <div ref={tagRef} className="nametag" aria-hidden="true">
          {name}
        </div>
      ) : null}
    </div>
  );
}
