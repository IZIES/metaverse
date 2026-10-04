import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { OtherUser } from '../Arena';
import type { SpaceElement } from './ElementsPanel';
import { findPath } from '../../utils/pathfinding';
import { drawDynamicAvatar } from '../../utils/drawAvatar';
import { MapControls } from './MapControls';

const TILE = 32;
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 3.0;
const WALKABLE_SURFACE_KEYWORDS = [
  'room',
  'floor',
  'rug',
  'carpet',
  'tile',
  'wood',
  'grass',
  'ground',
  'path',
  'walkable',
  'area',
];
const WALKABLE_SEAT_KEYWORDS = ['seating', 'chair', 'sofa', 'couch', 'bench', 'stool', 'seat'];

export interface PrivateZone {
  id: string;
  name: string;
  type?: 'public' | 'room' | 'seat' | 'private' | 'spawn' | 'portal' | 'spotlight';
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface MapCanvasProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  dimensions: { w: number; h: number };
  myPos: { x: number; y: number };
  cameraTarget?: { x: number; y: number };
  otherUsers: OtherUser[];
  proximityUsers?: string[];
  elements: SpaceElement[];
  hiddenElementIds?: string[];
  privateZones?: PrivateZone[];
  zoom: number;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  myAvatarUrl: string | null;
  autoPath: { x: number; y: number }[];
  setAutoPath: (path: { x: number; y: number }[]) => void;
  handleLocateUser: () => void;
  panOffset: { x: number; y: number };
  setPanOffset: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  myUsername?: string | null;
  onDropElement?: (elementId: string, x: number, y: number) => void;
  addingElement?: string | null;
  builderMode?: 'pointer' | 'brush' | 'eraser';
  onRemoveElement?: (id: string) => void;
  reactions?: Record<string, { emoji: string; expiresAt: number }>;
  onSelectUser?: (userId: string) => void;
  onManualControl?: () => void;
}

export const MapCanvas: React.FC<MapCanvasProps> = ({
  canvasRef,
  wrapperRef,
  dimensions,
  myPos,
  cameraTarget,
  otherUsers,
  proximityUsers = [],
  elements,
  hiddenElementIds = [],
  privateZones = [],
  zoom,
  setZoom,
  myAvatarUrl,
  autoPath,
  setAutoPath,
  handleLocateUser,
  panOffset,
  setPanOffset,
  myUsername,
  onDropElement,
  addingElement,
  builderMode = 'pointer',
  onRemoveElement,
  reactions = {},
  onSelectUser,
  onManualControl,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const initialPanRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const currentCamRef = useRef<{ camX: number; camY: number; zoom: number }>({ camX: 0, camY: 0, zoom: 1 });
  const imageCacheRef = useRef<Record<string, HTMLImageElement>>({});
  const userAnimStateRef = useRef<Record<string, { lastX: number; lastY: number; facing: 'down' | 'up' | 'left' | 'right'; step: number; isMoving: boolean }>>({});
  const [renderTrigger, setRenderTrigger] = useState(0);

  const normalizeAssetUrl = (url: string) => {
    if (url.startsWith('class:') || url.startsWith('http') || url.startsWith('/') || url.startsWith('data:')) return url;
    return `/${url}`;
  };

  // Handle window resize
  useEffect(() => {
    const handleResize = () => setRenderTrigger(t => t + 1);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Handle trackpad pinch-to-zoom (prevent browser zoom)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault(); // Prevents whole webpage from zooming!
      
      if (e.ctrlKey) {
        // Trackpad pinch gesture
        const factor = Math.exp(-e.deltaY / 100);
        setZoom(z => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor)));
      } else {
        // Standard mouse wheel
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        setZoom(z => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor)));
      }
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [setZoom]);

  const hasDraggedRef = useRef(false);

  // ── Mouse Drag / Free Camera Pan Map ────────────────
  const updatePanFromDrag = useCallback((clientX: number, clientY: number) => {
    if (!dragStartRef.current) return;

    if (builderMode === 'brush' || builderMode === 'eraser') {
      applyBuilderAction(clientX, clientY);
      return;
    }

    const dist = Math.hypot(clientX - dragStartRef.current.x, clientY - dragStartRef.current.y);
    if (dist > 4) {
      hasDraggedRef.current = true;
      onManualControl?.();
    }

    const dx = (clientX - dragStartRef.current.x) / currentCamRef.current.zoom;
    const dy = (clientY - dragStartRef.current.y) / currentCamRef.current.zoom;
    setPanOffset({
      x: initialPanRef.current.x - dx,
      y: initialPanRef.current.y - dy,
    });
  }, [builderMode, onManualControl, setPanOffset]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    setIsDragging(true);
    hasDraggedRef.current = false;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    initialPanRef.current = { ...panOffset };

    if (builderMode === 'brush' || builderMode === 'eraser') {
      applyBuilderAction(e.clientX, e.clientY);
    }
  };

  const applyBuilderAction = (clientX: number, clientY: number) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;
    const activeZoom = currentCamRef.current.zoom;
    const worldX = (mouseX / activeZoom) + currentCamRef.current.camX;
    const worldY = (mouseY / activeZoom) + currentCamRef.current.camY;
    const gridX = Math.floor(worldX / TILE);
    const gridY = Math.floor(worldY / TILE);
    if (gridX < 0 || gridY < 0 || gridX >= dimensions.w || gridY >= dimensions.h) return;

    if (builderMode === 'brush' && addingElement) {
      onDropElement?.(addingElement, gridX, gridY);
    } else if (builderMode === 'eraser') {
      // Find element at this position to erase
      const elToErase = elements.find(el => {
        return gridX >= el.x && gridX < el.x + el.element.width &&
               gridY >= el.y && gridY < el.y + el.element.height;
      });
      if (elToErase && onRemoveElement) {
        onRemoveElement(elToErase.id);
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging || !dragStartRef.current) return;
    updatePanFromDrag(e.clientX, e.clientY);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    dragStartRef.current = null;
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleWindowMove = (event: MouseEvent) => {
      updatePanFromDrag(event.clientX, event.clientY);
    };
    const handleWindowUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    window.addEventListener('mousemove', handleWindowMove);
    window.addEventListener('mouseup', handleWindowUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMove);
      window.removeEventListener('mouseup', handleWindowUp);
    };
  }, [isDragging, updatePanFromDrag]);

  // ── Click-to-move (A* Pathfinding to clicked tile) ──────────────────────
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (hasDraggedRef.current) {
      hasDraggedRef.current = false;
      return;
    }

    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const activeZoom = currentCamRef.current.zoom;
    const camX = currentCamRef.current.camX;
    const camY = currentCamRef.current.camY;

    const worldX = (mouseX / activeZoom) + camX;
    const worldY = (mouseY / activeZoom) + camY;

    const gridX = Math.floor(worldX / TILE);
    const gridY = Math.floor(worldY / TILE);

    if (gridX < 0 || gridY < 0 || gridX >= dimensions.w || gridY >= dimensions.h) return;

    const clickedUser = otherUsers.find((user) => {
      const px = user.x * TILE + TILE / 2;
      const py = user.y * TILE + TILE / 2 - 4;
      return Math.hypot(worldX - px, worldY - py) <= 22;
    });
    if (clickedUser) {
      onSelectUser?.(clickedUser.userId);
      return;
    }

    if (builderMode === 'brush' || builderMode === 'eraser') {
      return; // Handled by mouseDown/mouseMove
    }

    if (addingElement) {
      onDropElement?.(addingElement, gridX, gridY);
      return;
    }

    const path = findPath(
      myPos,
      { x: gridX, y: gridY },
      dimensions.w,
      dimensions.h,
      (x, y) => {
        const visibleElements = elements.filter(el => !hiddenElementIds.includes(el.id));
        const isStaticEl = visibleElements.some(el => {
          const text = `${el.element.id} ${el.element.name ?? ''} ${el.element.category ?? ''}`.toLowerCase();
          const isWalkableSurface = WALKABLE_SURFACE_KEYWORDS.some(keyword => text.includes(keyword));
          const isSeat = WALKABLE_SEAT_KEYWORDS.some(keyword => text.includes(keyword));
          if (el.element.category === 'Rooms' || isWalkableSurface || isSeat) return false;
          return el.element.static && x >= el.x && x < el.x + el.element.width && y >= el.y && y < el.y + el.element.height;
        });
        if (isStaticEl) return false;
        return true;
      }
    );

    if (path.length > 0) {
      onManualControl?.();
      setAutoPath(path);
    }
  };

  // ── Render 2D Canvas Engine ────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const viewW = wrapper.clientWidth;
    const viewH = wrapper.clientHeight;
    canvas.width = viewW;
    canvas.height = viewH;

    const worldW = dimensions.w * TILE;
    const worldH = dimensions.h * TILE;

    // Active zoom factor
    const activeZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));

    // Camera follows either the player or the active follow target.
    const targetPos = cameraTarget || myPos;
    const playerPx = targetPos.x * TILE + TILE / 2;
    const playerPy = targetPos.y * TILE + TILE / 2;

    let camX = playerPx - (viewW / activeZoom) / 2 + panOffset.x;
    let camY = playerPy - (viewH / activeZoom) / 2 + panOffset.y;

    // Handle camera bounds. Keep generous free-pan around the world so the map
    // can be inspected like a canvas without confusing it with playable tiles.
    const visibleWorldW = viewW / activeZoom;
    const visibleWorldH = viewH / activeZoom;
    const panPaddingX = Math.max(TILE * 12, visibleWorldW * 0.9);
    const panPaddingY = Math.max(TILE * 12, visibleWorldH * 0.9);
    const minCamX = worldW <= visibleWorldW ? -(visibleWorldW - worldW) / 2 - panPaddingX : -panPaddingX;
    const maxCamX = worldW <= visibleWorldW ? -(visibleWorldW - worldW) / 2 + panPaddingX : worldW - visibleWorldW + panPaddingX;
    const minCamY = worldH <= visibleWorldH ? -(visibleWorldH - worldH) / 2 - panPaddingY : -panPaddingY;
    const maxCamY = worldH <= visibleWorldH ? -(visibleWorldH - worldH) / 2 + panPaddingY : worldH - visibleWorldH + panPaddingY;

    camX = Math.max(minCamX, Math.min(camX, maxCamX));
    camY = Math.max(minCamY, Math.min(camY, maxCamY));

    // Save current camera transform parameters for mouse click calculations
    currentCamRef.current = { camX, camY, zoom: activeZoom };

    // Outside the playable map. Keep it visually distinct so padded camera
    // space does not look like walkable floor.
    ctx.fillStyle = '#c8d8cf';
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.save();
    ctx.scale(activeZoom, activeZoom);
    ctx.translate(-camX, -camY);

    // Gather-style base office floor to match Studio (dcf0e2)
    ctx.fillStyle = '#dcf0e2';
    ctx.fillRect(0, 0, worldW, worldH);

    ctx.save();
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.22)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(1, 1, Math.max(0, worldW - 2), Math.max(0, worldH - 2));
    ctx.restore();

    const isDiagramMode = activeZoom < 0.8;

    // Grid lines to match Studio (opacity 0.06 of black .4)
    if (!isDiagramMode) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.024)';
      ctx.lineWidth = 1;
      for (let y = 0; y <= worldH; y += TILE) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(worldW, y); ctx.stroke();
      }
      for (let x = 0; x <= worldW; x += TILE) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, worldH); ctx.stroke();
      }
    }

    const isRoomZone = (zone: any) => zone.type === 'room' || zone.type === 'private';

    // Render public areas, audio rooms, and room spots
    privateZones.forEach((zone: any) => {
      const zx = zone.startX * TILE;
      const zy = zone.startY * TILE;
      const zw = (zone.endX - zone.startX) * TILE;
      const zh = (zone.endY - zone.startY) * TILE;
      
      const isInside = myPos.x >= zone.startX && myPos.x < zone.endX && myPos.y >= zone.startY && myPos.y < zone.endY;

      ctx.save();
      // Draw Area Floor Color
      if (zone.floor) {
        ctx.fillStyle = zone.floor;
      } else {
        ctx.fillStyle = 'rgba(243, 244, 246, 0.4)'; // Match StudioArea default transparency
      }
      ctx.fillRect(zx, zy, zw, zh);

      if (isRoomZone(zone)) {
        ctx.strokeStyle = isInside ? '#22c55e' : (zone.color || '#16a34a');
        ctx.lineWidth = isInside ? 4 : 2;
        ctx.setLineDash([10, 6]);
      } else if (zone.type === 'seat') {
        ctx.strokeStyle = isInside ? '#f97316' : (zone.color || '#f97316');
        ctx.lineWidth = isInside ? 3 : 2;
        ctx.setLineDash([4, 4]);
      } else if (zone.type === 'spawn') {
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = isInside ? 4 : 2;
        ctx.setLineDash([2, 5]);
      } else if (zone.type === 'portal') {
        ctx.strokeStyle = '#a855f7';
        ctx.lineWidth = isInside ? 4 : 2;
        ctx.setLineDash([8, 4, 2, 4]);
      } else if (zone.type === 'spotlight') {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = isInside ? 4 : 2;
        ctx.setLineDash([12, 5]);
      } else {
        ctx.strokeStyle = isInside ? '#2563eb' : (zone.color || 'rgba(59, 130, 246, 0.5)');
        ctx.lineWidth = isInside ? 3 : 2;
        ctx.setLineDash([8, 8]);
      }
      
      ctx.strokeRect(zx, zy, zw, zh);

      // Area Name Label
      if (zone.name) {
        let labelText = zone.name;
        if (labelText === 'New Area' && zone.type !== 'seat') {
          labelText = '';
        }

        if (zone.type === 'seat') {
          const occupants = otherUsers.filter(u => u.x !== undefined && u.y !== undefined && u.x >= zone.startX && u.x < zone.endX && u.y >= zone.startY && u.y < zone.endY);
          const iAmOccupant = myPos.x >= zone.startX && myPos.x < zone.endX && myPos.y >= zone.startY && myPos.y < zone.endY;
          
          if (occupants.length === 0 && !iAmOccupant) {
            labelText = "Vacant";
          } else if (iAmOccupant) {
            labelText = "You";
          } else {
            labelText = occupants[0].username || "Occupied";
          }
        }

        if (zone.type === 'spawn' && !labelText) labelText = 'Spawn';
        if (zone.type === 'portal' && !labelText) labelText = 'Portal';
        if (zone.type === 'spotlight' && !labelText) labelText = 'Spotlight';

        if (labelText) {
          // Solid background for text readability
          const fontSize = isDiagramMode ? Math.max(12, 18 / activeZoom) : 12;
          ctx.font = `600 ${fontSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          
          const padding = 4;
          const textWidth = ctx.measureText(labelText).width;
          const textHeight = fontSize;
          
          ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
          ctx.beginPath();
          ctx.roundRect(zx + zw / 2 - textWidth / 2 - padding, zy + zh / 2 - textHeight / 2 - padding, textWidth + padding * 2, textHeight + padding * 2, 4);
          ctx.fill();

          ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
          ctx.fillText(labelText, zx + zw / 2, zy + zh / 2);
        }
      }
      
      ctx.restore();
    });

    // Outer office shell walls removed to match map editor perfectly

    // Elements (filtering out hidden elements)
    const visibleElements = elements.filter(el => !hiddenElementIds.includes(el.id));

    const isFloorElement = (el: SpaceElement) => {
      if (el.element.category === 'Rooms') return true;
      const text = `${el.element.id} ${el.element.name ?? ''} ${el.element.category ?? ''} ${el.element.imageUrl ?? ''}`.toLowerCase();
      return WALKABLE_SURFACE_KEYWORDS.some(keyword => text.includes(keyword));
    };

    // Draw Floors first
    const floors = visibleElements.filter(isFloorElement);
    // Draw Objects & Walls sorted by Y coordinate for depth
    const objects = visibleElements.filter(el => !isFloorElement(el)).sort((a, b) => a.y - b.y);

    const isInteractiveElement = (el: SpaceElement) => {
      const text = `${el.element.id} ${el.element.name ?? ''} ${el.element.category ?? ''}`.toLowerCase();
      return Boolean(el.element.interactiveObjects?.length) ||
        text.includes('whiteboard') ||
        text.includes('screen') ||
        text.includes('terminal') ||
        text.includes('arcade') ||
        text.includes('game') ||
        text.includes('interactive') ||
        text.includes('smart');
    };

    const drawInteractiveBadge = (el: SpaceElement) => {
      if (!isInteractiveElement(el)) return;
      const px = el.x * TILE;
      const py = el.y * TILE;
      const w = el.element.width * TILE;
      const cx = el.x + (el.element.width || 1) / 2;
      const cy = el.y + (el.element.height || 1) / 2;
      const nearby = Math.hypot(cx - myPos.x, cy - myPos.y) <= 2.25;

      ctx.save();
      if (nearby) {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.shadowColor = 'rgba(250, 204, 21, 0.55)';
        ctx.shadowBlur = 10;
        ctx.strokeRect(px + 2, py + 2, el.element.width * TILE - 4, el.element.height * TILE - 4);
        ctx.setLineDash([]);
      }

      ctx.fillStyle = nearby ? '#facc15' : 'rgba(15, 23, 42, 0.86)';
      ctx.beginPath();
      ctx.roundRect(px + w - 22, py + 4, 18, 18, 5);
      ctx.fill();
      ctx.fillStyle = nearby ? '#111827' : '#fff';
      ctx.font = '800 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('X', px + w - 13, py + 13);
      ctx.restore();
    };

    const drawElement = (el: SpaceElement, isFloor: boolean) => {
      const px = el.x * TILE;
      const py = el.y * TILE;
      const w = el.element.width * TILE;
      const h = el.element.height * TILE;

      // Draw custom floor background if specified (skip for Rooms, handled below)
      if (el.element.floor && el.element.category !== 'Rooms') {
        ctx.fillStyle = el.element.floor;
        ctx.fillRect(px, py, w, h);
      }

      // Draw custom wall top border if specified (skip for Rooms, handled below)
      if (el.element.wall && el.element.category !== 'Rooms') {
        ctx.fillStyle = el.element.wall;
        ctx.fillRect(px, py, w, Math.min(12, h));
      }

      if (el.element.imageUrl) {
        const imageUrl = normalizeAssetUrl(el.element.imageUrl);
        let img = imageCacheRef.current[imageUrl];
        if (!img) {
          img = new Image();
          img.src = imageUrl;
          img.onload = () => setRenderTrigger(t => t + 1);
          img.onerror = () => setRenderTrigger(t => t + 1);
          imageCacheRef.current[imageUrl] = img;
        }
        if (img.complete && img.naturalWidth > 0) {
          if (!isFloor) {
            ctx.fillStyle = 'rgba(0,0,0,0.2)';
            ctx.beginPath();
            ctx.ellipse(px + w / 2, py + h - 4, w / 2 - 4, 6, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.drawImage(img, px, py, w, h);

          // Apply color tint if specified
          if (el.element.color) {
            ctx.save();
            ctx.fillStyle = el.element.color;
            ctx.globalAlpha = 0.35;
            ctx.fillRect(px, py, w, h);
            ctx.restore();
          }
          drawInteractiveBadge(el);
          return;
        }
      }
      
      // Draw Rooms matching Studio visually
      if (el.element.category === 'Rooms') {
        ctx.fillStyle = el.element.floor || 'rgba(255, 255, 255, 0.4)';
        ctx.strokeStyle = '#9ca3af';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 8]);
        
        ctx.beginPath();
        ctx.roundRect(px, py, w, h, 12);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
        
        if (el.element.wall) {
          ctx.fillStyle = el.element.wall;
          ctx.beginPath();
          // Top corners rounded, bottom square
          ctx.roundRect(px, py, w, Math.min(12, h), [12, 12, 0, 0]);
          ctx.fill();
        }
        return;
      }

      // Fallback for custom objects without images
      ctx.fillStyle = el.element.color || (el.element.static ? 'rgba(100,116,139,0.5)' : 'rgba(16,185,129,0.3)');
      ctx.strokeStyle = el.element.wall || (el.element.static ? '#475569' : '#10b981');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(px + 2, py + 2, w - 4, h - 4, 6);
      ctx.fill();
      ctx.stroke();
      if (el.element.name) {
        ctx.fillStyle = '#1e293b';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(el.element.name, px + w / 2, py + h / 2);
      }
      drawInteractiveBadge(el);
    };

    floors.forEach(el => drawElement(el, true));
    if (!isDiagramMode) {
      objects.forEach(el => drawElement(el, false));
    }

    // Draw destination highlight tile & autoPath trajectory trail
    if (autoPath.length > 0) {
      const dest = autoPath[autoPath.length - 1];
      const destPx = dest.x * TILE;
      const destPy = dest.y * TILE;

      ctx.save();
      ctx.fillStyle = 'rgba(59, 130, 246, 0.35)';
      ctx.fillRect(destPx + 2, destPy + 2, TILE - 4, TILE - 4);

      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.shadowColor = '#3b82f6';
      ctx.shadowBlur = 8;
      ctx.strokeRect(destPx + 2, destPy + 2, TILE - 4, TILE - 4);
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(destPx + TILE / 2, destPy + TILE / 2, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(96, 165, 250, 0.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      const startPx = myPos.x * TILE + TILE / 2;
      const startPy = myPos.y * TILE + TILE / 2;
      ctx.moveTo(startPx, startPy);
      autoPath.forEach((pt) => {
        ctx.lineTo(pt.x * TILE + TILE / 2, pt.y * TILE + TILE / 2);
      });
      ctx.stroke();
      ctx.restore();
    }

    const updateAnim = (id: string, rx: number, ry: number) => {
      const cx = Math.round(rx);
      const cy = Math.round(ry);
      const prev = userAnimStateRef.current[id] || { lastX: cx, lastY: cy, facing: 'down', step: 0, isMoving: false };
      let facing = prev.facing;
      let isMoving = false;
      let step = prev.step;

      if (cx > prev.lastX + 2) { facing = 'right'; isMoving = true; step++; }
      else if (cx < prev.lastX - 2) { facing = 'left'; isMoving = true; step++; }
      else if (cy > prev.lastY + 2) { facing = 'down'; isMoving = true; step++; }
      else if (cy < prev.lastY - 2) { facing = 'up'; isMoving = true; step++; }

      userAnimStateRef.current[id] = { lastX: cx, lastY: cy, facing, step, isMoving };
      return userAnimStateRef.current[id];
    };

    const audioGroupUsers = otherUsers.filter(u => proximityUsers.includes(u.userId));
    if (audioGroupUsers.length > 0) {
      const points = [
        { x: myPos.x * TILE + TILE / 2, y: myPos.y * TILE + TILE / 2 },
        ...audioGroupUsers.map(u => ({ x: u.x * TILE + TILE / 2, y: u.y * TILE + TILE / 2 }))
      ];
      const minX = Math.min(...points.map(p => p.x)) - 26;
      const minY = Math.min(...points.map(p => p.y)) - 34;
      const maxX = Math.max(...points.map(p => p.x)) + 26;
      const maxY = Math.max(...points.map(p => p.y)) + 26;

      ctx.save();
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 7]);
      ctx.shadowColor = 'rgba(34, 197, 94, 0.55)';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.roundRect(minX, minY, maxX - minX, maxY - minY, 14);
      ctx.stroke();

      ctx.lineWidth = 1.5;
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
      ctx.restore();
    }

    const drawHumanCharacter = (
      x: number,
      y: number,
      userId: string,
      username: string,
      url?: string,
      isSitting: boolean = false,
      isMe: boolean = false
    ) => {
      const anim = updateAnim(userId, x, y);

      // If it's a real image (not a class prefix), draw it properly as a circle
      if (url && !url.startsWith('class:')) {
        const imageUrl = normalizeAssetUrl(url);
        let img = imageCacheRef.current[imageUrl];
        if (!img) {
          img = new Image();
          if (imageUrl.startsWith('http')) img.crossOrigin = 'anonymous';
          img.src = imageUrl;
          img.onload = () => setRenderTrigger(t => t + 1);
          img.onerror = () => setRenderTrigger(t => t + 1);
          imageCacheRef.current[imageUrl] = img;
        }
        if (img.complete && img.naturalWidth > 0) {
          const drawY = isSitting ? y + 4 : y - 4;
          const bobY = (anim.isMoving && !isSitting) ? (anim.step % 2 === 0 ? -2 : 0) : 0;
          const avSize = 28;
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, drawY + bobY, avSize / 2, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, x - avSize / 2, drawY + bobY - avSize / 2, avSize, avSize);
          ctx.restore();

          const charHash = Math.abs((userId || username || 'user').split('').reduce((acc, char) => acc + char.charCodeAt(0), 0));
          const shirtColors = ['#3b82f6', '#10b981', '#ec4899', '#8b5cf6', '#f59e0b', '#06b6d4', '#ef4444'];
          const shirtColor = isMe ? '#3b82f6' : shirtColors[charHash % shirtColors.length];

          ctx.strokeStyle = shirtColor;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(x, drawY + bobY, avSize / 2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
          return;
        }
      }

      // Draw dynamic class-based avatar
      drawDynamicAvatar(ctx, x, y, userId, username, url, isSitting, anim, isMe);
    };

    const drawReaction = (userId: string, x: number, y: number, isSitting: boolean) => {
      const reaction = reactions[userId];
      if (!reaction || reaction.expiresAt <= Date.now()) return;
      const fade = Math.min(1, Math.max(0, (reaction.expiresAt - Date.now()) / 450));
      const bubbleY = y - (isSitting ? 44 : 52);
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x - 18, bubbleY - 16, 36, 32, 12);
      ctx.fill();
      ctx.stroke();
      ctx.font = '22px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(reaction.emoji, x, bubbleY + 1);
      ctx.restore();
    };

    const isChair = (tx: number, ty: number) => visibleElements.some(el => {
      const text = `${el.element.id} ${el.element.name ?? ''} ${el.element.category ?? ''}`.toLowerCase();
      const isSeat = text.includes('seating') || text.includes('chair') || text.includes('sofa') || text.includes('couch') || text.includes('bench') || text.includes('stool') || text.includes('seat');
      return isSeat && tx >= el.x && tx < el.x + el.element.width && ty >= el.y && ty < el.y + el.element.height;
    });

    // Draw other users
    otherUsers.forEach((u) => {
      const px = u.x * TILE + TILE / 2;
      const py = u.y * TILE + TILE / 2 - 4;
      const sitting = isChair(u.x, u.y);
      const name = u.username || u.userId.slice(0, 5);

      drawHumanCharacter(px, py, u.userId, name, u.avatarUrl, sitting, false);
      drawReaction(u.userId, px, py, sitting);

      ctx.fillStyle = 'rgba(99,102,241,0.88)';
      const tagW = name.length * 6 + 8;
      ctx.beginPath();
      ctx.roundRect(px - tagW / 2, py - (sitting ? 22 : 30), tagW, 14, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, px, py - (sitting ? 15 : 23));
    });

    const mx = myPos.x * TILE + TILE / 2;
    const my = myPos.y * TILE + TILE / 2 - 4;
    const mySitting = isChair(myPos.x, myPos.y);
    const myName = myUsername || 'You';

    if (!mySitting) {
      const grd = ctx.createRadialGradient(mx, my, 0, mx, my, 18);
      grd.addColorStop(0, 'rgba(59,130,246,0.35)');
      grd.addColorStop(1, 'rgba(59,130,246,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(mx, my, 18, 0, Math.PI * 2);
      ctx.fill();
    }

    drawHumanCharacter(mx, my, 'me', myName, myAvatarUrl ?? undefined, mySitting, true);
    drawReaction('me', mx, my, mySitting);

    // My name pill badge
    ctx.fillStyle = '#3b82f6';
    const tagW = myName.length * 6 + 12;
    ctx.beginPath();
    ctx.roundRect(mx - tagW / 2, my - (mySitting ? 22 : 30), tagW, 14, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(myName, mx, my - (mySitting ? 15 : 23));
  }, [canvasRef, wrapperRef, myPos, cameraTarget, otherUsers, proximityUsers, elements, hiddenElementIds, privateZones, dimensions, myAvatarUrl, myUsername, renderTrigger, autoPath, zoom, panOffset, reactions]);

  return (
    <>
      <div className="canvas-wrapper" style={{ flex: 1, height: '100%', position: 'relative', overflow: 'hidden' }} ref={wrapperRef}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleCanvasClick}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(e) => {
            e.preventDefault();
            const elementId = e.dataTransfer.getData('elementId');
            if (!elementId || !canvasRef.current) return;
            const rect = canvasRef.current.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const activeZoom = currentCamRef.current.zoom;
            const camX = currentCamRef.current.camX;
            const camY = currentCamRef.current.camY;
            const worldX = (mouseX / activeZoom) + camX;
            const worldY = (mouseY / activeZoom) + camY;
            const tileX = Math.max(0, Math.min(dimensions.w - 1, Math.floor(worldX / TILE)));
            const tileY = Math.max(0, Math.min(dimensions.h - 1, Math.floor(worldY / TILE)));
            onDropElement?.(elementId, tileX, tileY);
          }}
          style={{ display: 'block', width: '100%', height: '100%', cursor: isDragging ? 'grabbing' : addingElement ? 'crosshair' : autoPath.length > 0 ? 'crosshair' : 'grab' }}
        />
      </div>

      <MapControls
        onZoomIn={() => setZoom(z => Math.min(z * 1.25, ZOOM_MAX))}
        onZoomOut={() => setZoom(z => Math.max(z / 1.25, ZOOM_MIN))}
        onOverview={() => setZoom(ZOOM_MIN)}
        onLocateUser={handleLocateUser}
      />
    </>
  );
};
