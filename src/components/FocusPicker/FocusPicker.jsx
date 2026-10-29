import { useEffect, useRef, useState } from "react";
import {
  CARD_VARIANTS,
  MAX_FOCUS_ZOOM,
  MIN_CROP_SIZE,
  focusFor,
  samePoint,
} from "../../../shared/types.js";

const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const CENTRE = { x: 0.5, y: 0.5 };
/** The whole image inside the card on a solid colour (see the server's containFrame). */
const WHOLE = { x: 0.5, y: 0.5, fit: "contain" };
const isWhole = (point) => point?.fit === "contain";
/** A free crop: any rectangle of the photo, stretched over the whole card (server: fit "fill"). */
const isFree = (point) => point?.fit === "crop";
/** Quick fill choices besides the image's own edge colour. */
const FILL_SWATCHES = [
  { value: "#ffffff", label: "White" },
  { value: "#000000", label: "Black" },
];
/** Keyboard nudge, as a share of the photo (Shift moves ten times as far). */
const NUDGE = 0.005;
/** Zoom change per wheel notch / per +/- key press. */
const ZOOM_STEP = 1.1;

/** Size of the largest crop box (zoom 1) for a card, as fractions of the photo. */
function baseBox(source, size) {
  const sourceRatio = source.width / source.height;
  const ratio = size.width / size.height;
  return sourceRatio > ratio
    ? { w: ratio / sourceRatio, h: 1 }
    : { w: 1, h: sourceRatio / ratio };
}

/**
 * The part of the photo a crop keeps, as fractions of the photo (like Figma's crop box).
 * x/y use CSS object-position semantics and zoom shrinks the box, the same rule the server
 * crops with, so the preview matches the generated image.
 */
function cropBox(source, size, point) {
  if (isWhole(point)) return { w: 1, h: 1, left: 0, top: 0, zoom: 1, whole: true };
  if (isFree(point)) return { w: point.w, h: point.h, left: point.x, top: point.y, zoom: 1, free: true };
  const base = baseBox(source, size);
  const p = point ?? CENTRE;
  const zoom = p.zoom ?? 1;
  const w = base.w / zoom;
  const h = base.h / zoom;
  return { w, h, left: (1 - w) * p.x, top: (1 - h) * p.y, zoom };
}

/** The crop for a box of `zoom` whose top-left corner is at (left, top), kept inside the photo. */
function pointForBox(source, size, left, top, zoom) {
  const base = baseBox(source, size);
  const z = round3(clamp(zoom, 1, MAX_FOCUS_ZOOM));
  const w = base.w / z;
  const h = base.h / z;
  const point = {
    x: w < 0.999 ? round3(clamp(left / (1 - w), 0, 1)) : 0.5,
    y: h < 0.999 ? round3(clamp(top / (1 - h), 0, 1)) : 0.5,
  };
  return z > 1 ? { ...point, zoom: z } : point;
}

/** The crop at `zoom` with the same centre as `box` (zooming in and out around the middle). */
function zoomAround(source, size, box, zoom) {
  const base = baseBox(source, size);
  const z = clamp(zoom, 1, MAX_FOCUS_ZOOM);
  const cx = box.left + box.w / 2;
  const cy = box.top + box.h / 2;
  return pointForBox(source, size, cx - base.w / z / 2, cy - base.h / z / 2, z);
}

/** A free crop of w × h at (left, top), kept inside the photo and at least MIN_CROP_SIZE. */
function freePoint(left, top, w, h) {
  const fw = round3(clamp(w, MIN_CROP_SIZE, 1));
  const fh = round3(clamp(h, MIN_CROP_SIZE, 1));
  return {
    x: round3(clamp(left, 0, 1 - fw)),
    y: round3(clamp(top, 0, 1 - fh)),
    w: fw,
    h: fh,
    fit: "crop",
  };
}

/** A free crop scaled by `factor` (above 1 = smaller box, i.e. zoom in) around its centre. */
function zoomFree(box, factor) {
  const s = clamp(1 / factor, MIN_CROP_SIZE / Math.min(box.w, box.h), 1 / Math.max(box.w, box.h));
  const w = box.w * s;
  const h = box.h * s;
  return freePoint(box.left + (box.w - w) / 2, box.top + (box.h - h) / 2, w, h);
}

/** How much a free crop is stretched in the card: its shape's ratio to the card's (1 = none). */
function stretchOf(source, size, box) {
  return (box.w * source.width) / (box.h * source.height) / (size.width / size.height);
}

const WHOLE_IMAGE = { left: 0, top: 0, width: 1, height: 1 };

/** Positions an image so that `region` (fractions of it) exactly fills its frame. */
function regionStyle(region) {
  return {
    position: "absolute",
    maxWidth: "none",
    // A free crop's region can differ from the frame's shape; it is stretched, as the server does.
    objectFit: "fill",
    width: `${100 / region.width}%`,
    height: `${100 / region.height}%`,
    left: `${(-region.left / region.width) * 100}%`,
    top: `${(-region.top / region.height) * 100}%`,
  };
}

/** Adds a non-passive wheel listener (React's onWheel cannot prevent the page from scrolling). */
function useWheel(ref, handler) {
  const saved = useRef(handler);
  saved.current = handler;
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onWheel = (e) => saved.current(e);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}

/**
 * Crops the featured image separately for each card, like Figma's crop mode: pick a card, then
 * drag its box over the original image, drag a corner to resize it (zoom), or scroll to zoom.
 * Each card preview can also be dragged and scrolled directly. Starts from the automatic crop
 * the server chose. Padding the server cut off the original (a publisher's blurred side panels,
 * for instance) is hidden here too.
 */
export function FocusPicker({ imageUrl, focus, variants, sizes, disabled, busy, onApply }) {
  const [active, setActive] = useState(CARD_VARIANTS[0].key);
  const [draft, setDraft] = useState({});
  const [natural, setNatural] = useState(null);
  const drag = useRef(null);
  const stage = useRef(null);

  // A save (or a reload with new crops) clears the unsaved changes.
  useEffect(() => setDraft({}), [JSON.stringify(focus ?? null)]);

  // The photo inside the original, as the server found it; every variant shares one source.
  const content =
    Object.values(variants ?? {}).find((v) => v?.content)?.content ?? WHOLE_IMAGE;
  const source = natural && {
    width: natural.width * content.width,
    height: natural.height * content.height,
  };
  /** The part of the original a crop box (fractions of the photo) shows. */
  const inOriginal = (box) => ({
    left: content.left + box.left * content.width,
    top: content.top + box.top * content.height,
    width: box.w * content.width,
    height: box.h * content.height,
  });

  const sizeOf = (key) => sizes?.[key] ?? CARD_VARIANTS.find((v) => v.key === key);
  /** The editor's crop for a card (unsaved first), or null for the automatic one. */
  const customOf = (key) => (key in draft ? draft[key] : focusFor(focus, key));
  /** The automatic crop the server chose; older images without one are shown centred. */
  const autoOf = (key) => variants?.[key]?.auto ?? null;
  const shownOf = (key) => customOf(key) ?? autoOf(key) ?? CENTRE;
  const changes = Object.fromEntries(
    Object.entries(draft).filter(([key, point]) => !samePoint(point, focusFor(focus, key))),
  );
  const changedCount = Object.keys(changes).length;

  const size = sizeOf(active);
  const point = shownOf(active);
  const box = source ? cropBox(source, size, point) : null;
  const isCustom = !!customOf(active);
  const setPoint = (key, next) => setDraft((d) => ({ ...d, [key]: next }));
  /** The image's edge colour for a card's shape, as the server measured it (null if unknown). */
  const edgeOf = (key) => variants?.[key]?.edgeFill ?? null;
  /** The colour around the whole image in a card: the chosen one, else the edge colour. */
  const fillOf = (key) => shownOf(key).fill ?? edgeOf(key);
  const setFill = (fill) => setPoint(active, fill ? { ...WHOLE, fill } : { ...WHOLE });

  /** Pointer position as fractions of the photo shown in the large view. */
  const photoPoint = (e) => {
    const rect = stage.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  };

  const startDrag = (e, mode, extra = {}) => {
    if (disabled || !source || !box || box.whole) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, start: photoPoint(e), box, ...extra };
  };

  const onStagePointerDown = (e) => {
    if (disabled || !source || !box || box.whole) return;
    // Pressing outside the box moves it there first, then drags it.
    const p = photoPoint(e);
    const inside =
      p.x >= box.left && p.x <= box.left + box.w && p.y >= box.top && p.y <= box.top + box.h;
    let current = box;
    if (!inside) {
      const next = box.free
        ? freePoint(p.x - box.w / 2, p.y - box.h / 2, box.w, box.h)
        : pointForBox(source, size, p.x - box.w / 2, p.y - box.h / 2, box.zoom);
      setPoint(active, next);
      current = cropBox(source, size, next);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode: "move", start: p, box: current };
  };

  const onStagePointerMove = (e) => {
    const d = drag.current;
    if (!d || !source) return;
    const p = photoPoint(e);
    if (d.mode === "move") {
      const left = d.box.left + p.x - d.start.x;
      const top = d.box.top + p.y - d.start.y;
      setPoint(
        active,
        d.box.free
          ? freePoint(left, top, d.box.w, d.box.h)
          : pointForBox(source, size, left, top, d.box.zoom),
      );
      return;
    }
    if (d.box.free) {
      // A free crop resizes each dragged side on its own, keeping the opposite side in place.
      const side = (s, a, pos, start, extent) => {
        if (!s) return [start, extent];
        const len = clamp((pos - a) * s, MIN_CROP_SIZE, s > 0 ? 1 - a : a);
        return [s > 0 ? a : a - len, len];
      };
      const [left, w] = side(d.sx, d.ax, p.x, d.box.left, d.box.w);
      const [top, h] = side(d.sy, d.ay, p.y, d.box.top, d.box.h);
      setPoint(active, freePoint(left, top, w, h));
      return;
    }
    // Resizing from a corner keeps the opposite corner in place and the card's shape.
    const base = baseBox(source, size);
    const { ax, ay, sx, sy } = d;
    const fromX = (p.x - ax) * sx;
    const fromY = ((p.y - ay) * sy * base.w) / base.h;
    const room = Math.min(sx > 0 ? 1 - ax : ax, ((sy > 0 ? 1 - ay : ay) * base.w) / base.h);
    const w = clamp(Math.max(fromX, fromY), base.w / MAX_FOCUS_ZOOM, Math.min(base.w, room));
    const h = (w * base.h) / base.w;
    setPoint(active, pointForBox(source, size, sx > 0 ? ax : ax - w, sy > 0 ? ay : ay - h, base.w / w));
  };

  const endDrag = () => {
    drag.current = null;
  };

  /** Starts resizing from a corner; sx/sy point away from the fixed opposite corner. */
  const startResize = (e, sx, sy) =>
    startDrag(e, "resize", {
      sx,
      sy,
      ax: sx > 0 ? box.left : box.left + box.w,
      ay: sy > 0 ? box.top : box.top + box.h,
    });

  const zoomBy = (key, factor) => {
    if (disabled || !source) return;
    const s = sizeOf(key);
    const current = cropBox(source, s, shownOf(key));
    if (current.whole) return;
    setPoint(
      key,
      current.free ? zoomFree(current, factor) : zoomAround(source, s, current, current.zoom * factor),
    );
  };

  /** Switches the active card to a free crop starting from the box it shows now, or back. */
  const toggleFree = () => {
    if (!box) return;
    if (box.free) {
      // Back to a card-shaped frame around the same centre, as large as fits.
      const base = baseBox(source, size);
      const z = Math.min(base.w / box.w, base.h / box.h);
      setPoint(active, zoomAround(source, size, box, Math.max(1, z)));
    } else {
      setPoint(active, freePoint(box.left, box.top, box.w, box.h));
    }
  };

  useWheel(stage, (e) => {
    if (disabled || !source) return;
    e.preventDefault();
    zoomBy(active, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  });

  const onKeyDown = (e) => {
    if (disabled || !source || !box || box.whole) return;
    const step = e.shiftKey ? NUDGE * 10 : NUDGE;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dx, dy] = moves[e.key];
      setPoint(
        active,
        box.free
          ? freePoint(box.left + dx, box.top + dy, box.w, box.h)
          : pointForBox(source, size, box.left + dx, box.top + dy, box.zoom),
      );
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomBy(active, ZOOM_STEP);
    } else if (e.key === "-") {
      e.preventDefault();
      zoomBy(active, 1 / ZOOM_STEP);
    }
  };

  return (
    <div className="focusPicker">
      <div className="focusHeader">
        <strong>Crop</strong>
        <small className="muted">
          Each card has its own crop. Drag the box to move it, drag a corner or scroll to zoom. You
          can also drag and scroll inside a card preview. Free crop lets you pick any rectangle;
          it then fills the card's full width and height. Fit whole image shows the entire image
          centred on a solid colour.
        </small>
      </div>

      <div className="focusTabs" role="tablist" aria-label="Card to crop">
        {CARD_VARIANTS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active === key}
            className={`focusTab ${active === key ? "isActive" : ""}`}
            onClick={() => setActive(key)}
          >
            {label}
            <span className="muted small">
              {key in changes
                ? " · unsaved"
                : isWhole(customOf(key))
                  ? " · whole image"
                  : isFree(customOf(key))
                    ? " · free crop"
                    : customOf(key)
                    ? " · custom"
                    : " · automatic"}
            </span>
          </button>
        ))}
      </div>

      <div className="focusBody">
        <div className="focusMain">
          <div
            ref={stage}
            className={`focusSource ${disabled ? "isDisabled" : ""}`}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onKeyDown}
            tabIndex={disabled ? -1 : 0}
            style={{ aspectRatio: source ? `${source.width} / ${source.height}` : "16 / 9" }}
            role="application"
            aria-label="Original image with the crop box of the selected card. Arrow keys move the box, plus and minus zoom."
          >
            <img
              src={imageUrl}
              alt=""
              referrerPolicy="no-referrer"
              draggable={false}
              style={regionStyle(content)}
              onLoad={(e) =>
                setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
              }
            />
            {box && (
              <span
                className={`focusWindow ${isCustom ? "" : "isAuto"} ${box.whole ? "isWhole" : ""}`}
                style={{
                  left: `${box.left * 100}%`,
                  top: `${box.top * 100}%`,
                  width: `${box.w * 100}%`,
                  height: `${box.h * 100}%`,
                }}
              >
                <span className="focusGrid" aria-hidden="true" />
                {!disabled &&
                  !box.whole &&
                  [
                    [-1, -1, "nw"],
                    [1, -1, "ne"],
                    [-1, 1, "sw"],
                    [1, 1, "se"],
                    // A free crop's sides move on their own too.
                    ...(box.free
                      ? [
                          [0, -1, "n"],
                          [1, 0, "e"],
                          [0, 1, "s"],
                          [-1, 0, "w"],
                        ]
                      : []),
                  ].map(([sx, sy, corner]) => (
                    <span
                      key={corner}
                      className={`focusHandle is-${corner}`}
                      onPointerDown={(e) => startResize(e, sx, sy)}
                      onPointerMove={onStagePointerMove}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                      aria-hidden="true"
                    />
                  ))}
              </span>
            )}
          </div>

          <div className="focusZoom">
            <label className="focusZoomSlider">
              <span className="small">Zoom</span>
              <input
                type="range"
                min={1}
                max={MAX_FOCUS_ZOOM}
                step={0.01}
                value={box?.zoom ?? 1}
                disabled={disabled || !source || !!box?.whole || !!box?.free}
                onChange={(e) => box && setPoint(active, zoomAround(source, size, box, Number(e.target.value)))}
              />
              <span className="small mono">{Math.round((box?.zoom ?? 1) * 100)}%</span>
            </label>
            <div className="focusZoomButtons">
              <button
                type="button"
                className="btn btnSmall"
                disabled={
                  disabled ||
                  !box ||
                  (!box.whole && !box.free && box.zoom === 1 && point.x === 0.5 && point.y === 0.5)
                }
                onClick={() => setPoint(active, { ...CENTRE })}
                title="Largest box, centred"
              >
                Fit &amp; centre
              </button>
              <button
                type="button"
                className={`btn btnSmall ${box?.free ? "btnPrimary" : ""}`}
                aria-pressed={!!box?.free}
                disabled={disabled || !box || box.whole}
                onClick={toggleFree}
                title="Crop any rectangle of the image; it is stretched to fill the card's full width and height."
              >
                Free crop
              </button>
              <button
                type="button"
                className={`btn btnSmall ${box?.whole ? "btnPrimary" : ""}`}
                aria-pressed={!!box?.whole}
                disabled={disabled || !box}
                onClick={() => setPoint(active, box.whole ? { ...CENTRE } : { ...WHOLE })}
                title="Show the entire image in this card without cropping, on a solid colour."
              >
                Fit whole image
              </button>
              <button
                type="button"
                className="btn btnSmall"
                disabled={disabled || !isCustom}
                onClick={() => setPoint(active, null)}
                title="Use the crop the server picked for this card"
              >
                Automatic
              </button>
            </div>
          </div>
          {box?.free && source && (
            <FreeCropInfo
              stretch={stretchOf(source, size, box)}
              disabled={disabled}
              onMatch={() => {
                // The largest card-shaped box inside the free crop, around its centre.
                const k = stretchOf(source, size, box);
                const w = k > 1 ? box.w / k : box.w;
                const h = k > 1 ? box.h : box.h * k;
                setPoint(active, freePoint(box.left + (box.w - w) / 2, box.top + (box.h - h) / 2, w, h));
              }}
            />
          )}
          {box?.whole && (
            <div className="focusFill" role="group" aria-label="Colour around the image">
              <span className="small">Background</span>
              <button
                type="button"
                className={`fillChip ${point.fill ? "" : "isSelected"}`}
                aria-pressed={!point.fill}
                disabled={disabled}
                onClick={() => setFill(null)}
                title="The colour of the image's own edges"
              >
                <span className="fillSwatch" style={{ background: edgeOf(active) ?? undefined }} />
                Edge colour
              </button>
              {FILL_SWATCHES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`fillChip ${point.fill === value ? "isSelected" : ""}`}
                  aria-pressed={point.fill === value}
                  disabled={disabled}
                  onClick={() => setFill(value)}
                >
                  <span className="fillSwatch" style={{ background: value }} />
                  {label}
                </button>
              ))}
              <label
                className={`fillChip ${point.fill && !FILL_SWATCHES.some((f) => f.value === point.fill) ? "isSelected" : ""}`}
                title="Pick any colour"
              >
                <input
                  type="color"
                  value={fillOf(active) ?? "#ffffff"}
                  disabled={disabled}
                  onChange={(e) => setFill(e.target.value.toLowerCase())}
                />
                Custom
              </label>
            </div>
          )}
        </div>

        <div className="focusCrops">
          {CARD_VARIANTS.map(({ key, label }) => (
            <CropPreview
              key={key}
              label={label}
              isActive={active === key}
              size={sizeOf(key)}
              source={source}
              imageUrl={imageUrl}
              generated={variants?.[key]?.url}
              region={source ? inOriginal(cropBox(source, sizeOf(key), shownOf(key))) : null}
              content={content}
              whole={isWhole(shownOf(key))}
              fill={fillOf(key)}
              // Unsaved crops are previewed in CSS; otherwise show the image the server made.
              live={key in changes || !variants?.[key]?.url}
              approx={!customOf(key) && !autoOf(key)}
              disabled={disabled}
              onSelect={() => setActive(key)}
              onPan={(dx, dy) => {
                const s = sizeOf(key);
                const current = cropBox(source, s, shownOf(key));
                // Dragging the picture right shows more of its left side: the box moves left.
                if (current.whole) return;
                const left = current.left - dx * current.w;
                const top = current.top - dy * current.h;
                setPoint(
                  key,
                  current.free
                    ? freePoint(left, top, current.w, current.h)
                    : pointForBox(source, s, left, top, current.zoom),
                );
              }}
              onZoom={(factor) => zoomBy(key, factor)}
            />
          ))}
        </div>
      </div>

      <div className="actionsRow">
        <button
          type="button"
          className="btn btnSmall btnPrimary"
          disabled={disabled || changedCount === 0}
          onClick={() => onApply(changes)}
        >
          {busy
            ? "Cropping…"
            : `Apply ${changedCount > 1 ? `${changedCount} crops` : "crop"}`}
        </button>
        {changedCount > 0 && (
          <button
            type="button"
            className="btn btnSmall"
            disabled={disabled}
            onClick={() => setDraft({})}
          >
            Discard
          </button>
        )}
        {CARD_VARIANTS.some(({ key }) => customOf(key)) && (
          <button
            type="button"
            className="btn btnSmall btnGhost"
            disabled={disabled}
            onClick={() =>
              setDraft(Object.fromEntries(CARD_VARIANTS.map(({ key }) => [key, null])))
            }
          >
            All cards automatic
          </button>
        )}
        <small className="muted">Applying shows the crops in the card outputs below; Convert to CDN uploads them.</small>
      </div>
    </div>
  );
}

/**
 * How much a free crop is stretched to fill the card, with a button that trims it to the card's
 * shape so nothing is distorted.
 */
function FreeCropInfo({ stretch, disabled, onMatch }) {
  const off = Math.abs(Math.log(stretch)) > Math.log(1.02);
  return (
    <div className="focusFreeInfo small">
      {off ? (
        <span className="muted">
          Fills the card by stretching the crop{" "}
          {stretch > 1 ? "vertically" : "horizontally"}{" "}
          <span className="mono">{(stretch > 1 ? stretch : 1 / stretch).toFixed(2)}×</span>.
        </span>
      ) : (
        <span className="muted">Matches the card's shape; nothing is stretched.</span>
      )}
      {off && (
        <button type="button" className="btn btnSmall btnGhost" disabled={disabled} onClick={onMatch}>
          Match card shape
        </button>
      )}
    </div>
  );
}

/** One card's crop, at the card's shape; drag to move the picture inside it, scroll to zoom. */
function CropPreview({
  label,
  isActive,
  size,
  source,
  imageUrl,
  generated,
  region,
  content,
  whole,
  fill,
  live,
  approx,
  disabled,
  onSelect,
  onPan,
  onZoom,
}) {
  const frame = useRef(null);
  const last = useRef(null);

  useWheel(frame, (e) => {
    if (disabled || !source) return;
    e.preventDefault();
    onSelect();
    onZoom(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  });

  return (
    <div className={`focusCrop ${isActive ? "isActive" : ""}`}>
      <span
        ref={frame}
        className={`focusCropFrame ${disabled ? "" : "isDraggable"}`}
        style={{ aspectRatio: `${size.width} / ${size.height}` }}
        onPointerDown={(e) => {
          onSelect();
          if (disabled || !source) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          last.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          if (!last.current) return;
          const rect = frame.current.getBoundingClientRect();
          onPan((e.clientX - last.current.x) / rect.width, (e.clientY - last.current.y) / rect.height);
          last.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={() => (last.current = null)}
        onPointerCancel={() => (last.current = null)}
      >
        {live || !generated ? (
          source &&
          region &&
          (whole ? (
            <WholePreview size={size} source={source} imageUrl={imageUrl} content={content} fill={fill} />
          ) : (
            <img src={imageUrl} alt="" referrerPolicy="no-referrer" draggable={false} style={regionStyle(region)} />
          ))
        ) : (
          <img src={generated} alt="" referrerPolicy="no-referrer" draggable={false} />
        )}
      </span>
      <button type="button" className="focusCropLabel muted small" onClick={onSelect}>
        {label}
        {live && (approx || (whole && !fill)) && " (approx.)"}
      </button>
    </div>
  );
}

/**
 * The whole image centred in a card on a solid colour, as the server makes it. Images processed
 * before edge colours were recorded show white until the crop is applied.
 */
function WholePreview({ size, source, imageUrl, content, fill }) {
  const frameRatio = size.width / size.height;
  const sourceRatio = source.width / source.height;
  // The photo's box inside the card, in % of the card.
  const w = sourceRatio > frameRatio ? 100 : (sourceRatio / frameRatio) * 100;
  const h = sourceRatio > frameRatio ? (frameRatio / sourceRatio) * 100 : 100;
  return (
    <>
      <span className="focusWholeFill" style={{ background: fill ?? "#ffffff" }} />
      <span
        className="focusWholePhoto"
        style={{ width: `${w}%`, height: `${h}%`, left: `${(100 - w) / 2}%`, top: `${(100 - h) / 2}%` }}
      >
        <img src={imageUrl} alt="" referrerPolicy="no-referrer" draggable={false} style={regionStyle(content)} />
      </span>
    </>
  );
}
