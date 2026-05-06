/**
 * dragReorder.js — shared pointer-driven drag helper.
 *
 * Used by every card-drag UI in the apps (HP tracker, Arrange, Trade, Group
 * Loot). Handles the boilerplate that was previously copy-pasted four times:
 *
 *   - Builds a fixed-position cloned "ghost" of the source tile that follows
 *     the cursor.
 *   - Adds a faded `.drag-source` style to the original tile.
 *   - Wires capture-phase pointermove/pointerup listeners and tears them down
 *     reliably on pointerup or when the drag is cancelled.
 *
 * Two patterns are supported via the `livePreview` flag:
 *
 *   livePreview: false  — Source tile stays put; the caller's `onDrop` decides
 *                         what changed based on cursor position at release.
 *                         Used by Trade and Group Loot.
 *
 *   livePreview: true   — Source tile is moved into the target zone DOM during
 *                         drag, giving a live insert preview. The caller's
 *                         `onMove` hook tells the helper which zone is under
 *                         the cursor, and the helper handles the actual DOM
 *                         insert. Used by Arrange and HP tracker.
 *
 * The helper is CSS-z-index-agnostic — set the ghost's z-index in your stylesheet
 * via the class you pass as `ghostClass`.
 */

const _drag = {
  active:    false,
  sourceEl:  null,
  ghost:     null,
  card:      null,
  fromZone:  null,
  offsetX:   0,
  offsetY:   0,
  // Bound event handler refs so removeEventListener actually removes them
  _move:     null,
  _up:       null,
};

/**
 * Returns true if a drag is currently in progress.
 */
export function isDragging() {
  return _drag.active;
}

/**
 * Starts a drag.
 *
 * @param {object} opts
 * @param {PointerEvent} opts.event       - The pointerdown event
 * @param {HTMLElement}  opts.tile        - The source tile being dragged
 * @param {*}            opts.card        - Arbitrary "what is being dragged" payload, passed to onDrop
 * @param {string}      [opts.ghostClass='drag-ghost']  - CSS class for the ghost clone
 * @param {string}      [opts.sourceClass='drag-source'] - CSS class for the faded source while dragging
 * @param {string}      [opts.zoneAttr='data-zone']     - Attribute name on zone elements; used to read fromZone
 * @param {boolean}     [opts.livePreview=false] - If true, caller can move the source DOM element via the helper's API
 * @param {Function}    [opts.onMove]    - Optional ({ event, ghost }) => void hook called on every pointermove (after ghost is positioned). Use to drive live-preview DOM moves.
 * @param {Function}     opts.onDrop     - ({ event, card, fromZone, sourceEl }) => void|Promise<void>; called on pointerup
 */
export function startDrag({
  event,
  tile,
  card,
  ghostClass  = 'drag-ghost',
  sourceClass = 'drag-source',
  zoneAttr    = 'data-zone',
  livePreview = false,
  onMove,
  onDrop,
}) {
  // Left button only
  if (event.button !== undefined && event.button !== 0) return;

  // Don't start a second drag on top of an existing one
  if (_drag.active) return;

  event.preventDefault();
  event.stopPropagation();

  const rect = tile.getBoundingClientRect();
  _drag.active   = true;
  _drag.sourceEl = tile;
  _drag.card     = card;
  _drag.offsetX  = event.clientX - rect.left;
  _drag.offsetY  = event.clientY - rect.top;

  // Capture the originating zone (data-zone attribute on the closest ancestor).
  const zoneEl = tile.closest(`[${zoneAttr}]`);
  _drag.fromZone = zoneEl ? zoneEl.getAttribute(zoneAttr) : null;

  // Build the ghost clone that follows the cursor
  const ghost = tile.cloneNode(true);
  // Normalise: drop the source class if it was already on the source, drop
  // any inline drag styling (which could be stale from an earlier drag).
  ghost.classList.remove(sourceClass);
  ghost.className   = `${ghost.className} ${ghostClass}`.trim();
  ghost.style.width = `${rect.width}px`;
  ghost.style.left  = `${rect.left}px`;
  ghost.style.top   = `${rect.top}px`;
  // Default styles for the ghost so callers don't have to remember every one.
  // Stylesheets can still override via the ghostClass selector.
  ghost.style.position      = 'fixed';
  ghost.style.pointerEvents = 'none';
  document.body.appendChild(ghost);
  _drag.ghost = ghost;

  tile.classList.add(sourceClass);

  // Bind handlers so removeEventListener works
  _drag._move = (e) => {
    if (!_drag.active) return;
    _drag.ghost.style.left = `${e.clientX - _drag.offsetX}px`;
    _drag.ghost.style.top  = `${e.clientY - _drag.offsetY}px`;
    if (onMove) onMove({ event: e, ghost: _drag.ghost, sourceEl: _drag.sourceEl });
  };
  _drag._up = async (e) => {
    if (!_drag.active) return;
    // Tear down first so onDrop can re-trigger drag-related code without re-entry
    const captured = {
      event:    e,
      card:     _drag.card,
      fromZone: _drag.fromZone,
      sourceEl: _drag.sourceEl,
    };
    cancelDrag({ removeSourceClass: true, sourceClass });

    if (onDrop) {
      try {
        await onDrop(captured);
      } catch (err) {
        // The caller's onDrop is responsible for surfacing user-facing errors.
        // We log here so silent crashes don't disappear without trace.
        console.error('drag onDrop handler threw:', err);
      }
    }
  };

  document.addEventListener('pointermove', _drag._move, { capture: true });
  document.addEventListener('pointerup',   _drag._up,   { capture: true });
}

/**
 * Cleans up the drag state. Called automatically on pointerup; can be called
 * manually (e.g. on Escape) to abort an in-flight drag.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.removeSourceClass=true] - Whether to clean up the source's faded class
 * @param {string}  [opts.sourceClass='drag-source']
 */
export function cancelDrag({ removeSourceClass = true, sourceClass = 'drag-source' } = {}) {
  if (!_drag.active) return;
  _drag.active = false;

  if (_drag.ghost) {
    _drag.ghost.remove();
    _drag.ghost = null;
  }
  if (removeSourceClass && _drag.sourceEl) {
    _drag.sourceEl.classList.remove(sourceClass);
  }

  if (_drag._move) {
    document.removeEventListener('pointermove', _drag._move, { capture: true });
    _drag._move = null;
  }
  if (_drag._up) {
    document.removeEventListener('pointerup', _drag._up, { capture: true });
    _drag._up = null;
  }

  _drag.sourceEl = null;
  _drag.card     = null;
  _drag.fromZone = null;
}

/**
 * Convenience: hit-tests cursor position against a list of zone elements.
 * Returns the matching zone's `data-zone` value (or whichever attribute was
 * passed via zoneAttr in startDrag).
 *
 * @param {PointerEvent} event
 * @param {HTMLElement[]} zoneEls
 * @param {string} [zoneAttr='data-zone']
 * @returns {string|null}
 */
export function findZoneAt(event, zoneEls, zoneAttr = 'data-zone') {
  for (const el of zoneEls) {
    const r = el.getBoundingClientRect();
    if (event.clientX >= r.left && event.clientX <= r.right &&
        event.clientY >= r.top  && event.clientY <= r.bottom) {
      return el.getAttribute(zoneAttr);
    }
  }
  return null;
}

/**
 * Convenience: finds the non-source tile (selector) directly under the cursor
 * within a given container. Used by live-preview drags to pick an insertion
 * neighbour.
 *
 * @param {PointerEvent} event
 * @param {HTMLElement} container
 * @param {string}      tileSelector - Selector for sibling tiles
 * @param {string}      sourceClass  - Class marking the placeholder source
 * @returns {HTMLElement|null}
 */
export function findTileAt(event, container, tileSelector, sourceClass = 'drag-source') {
  const tiles = container.querySelectorAll(`${tileSelector}:not(.${sourceClass})`);
  for (const t of tiles) {
    const r = t.getBoundingClientRect();
    if (event.clientX >= r.left && event.clientX <= r.right &&
        event.clientY >= r.top  && event.clientY <= r.bottom) {
      return t;
    }
  }
  return null;
}
