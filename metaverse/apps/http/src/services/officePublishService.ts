import client from "@repo/db/client";
import { summarizeMapData, writeMapAuditEvent } from "./mapAudit.js";
import { validatePortalTargets } from "./portalValidation.js";
import type { SpaceAccess } from "./officeAccess.js";

export class PublishValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishValidationError";
  }
}

export async function publishOfficeDraft(space: SpaceAccess, draft: { data: unknown }, userId: string) {
  const data = draft.data as any;
  const portalTargetError = validatePortalTargets(data, space.width, space.height || space.width);
  if (portalTargetError) throw new PublishValidationError(portalTargetError);

  if (Array.isArray(data.elements)) {
    await syncDraftElements(space.id, data.elements);
  }

  if (Array.isArray(data.areas)) {
    await syncDraftAreas(space.id, data.areas);
  }

  const version = await createMapVersion(space.id, data, userId);
  void writeMapAuditEvent({
    spaceId: space.id,
    action: "published",
    actorUserId: userId,
    summary: summarizeMapData(data),
    versionId: version.id,
    versionNumber: version.version,
  });

  return client.spaceDraft.update({
    where: { spaceId: space.id },
    data: { publishedAt: new Date() },
  }).catch(() => null);
}

async function syncDraftElements(spaceId: string, elements: any[]) {
  const dbElements = await client.element.findMany({ select: { id: true } });
  const validElementIds = new Set(dbElements.map((element: any) => element.id));
  const fallbackElementId = dbElements[0]?.id;

  await client.spaceElements.deleteMany({ where: { spaceId } });

  const elementsToInsert = elements
    .filter((element: any) => element.element)
    .map((element: any) => {
      const targetElementId = validElementIds.has(element.element.id) ? element.element.id : fallbackElementId;
      if (!targetElementId) return null;

      return {
        spaceId,
        elementId: targetElementId,
        x: element.x,
        y: element.y,
        customData: {
          width: element.element.width,
          height: element.element.height,
          color: element.element.color,
          floor: element.element.floor,
          wall: element.element.wall,
          name: element.element.name,
          category: element.element.category,
          imageUrl: element.element.imageUrl,
          colorMaskUrl: element.element.colorMaskUrl,
          interactiveObjects: Array.isArray(element.element.interactiveObjects) ? element.element.interactiveObjects : undefined,
        },
      };
    })
    .filter((element: any): element is NonNullable<typeof element> => element !== null);

  if (elementsToInsert.length > 0) {
    await client.spaceElements.createMany({ data: elementsToInsert });
  }
}

async function syncDraftAreas(spaceId: string, areas: any[]) {
  await client.privateZone.deleteMany({ where: { spaceId } });

  const space = await client.space.findUnique({
    where: { id: spaceId },
    select: { width: true, height: true },
  });
  const mapWidth = space?.width ?? 0;
  const mapHeight = space?.height ?? 0;

  let defaultSpawnConsumed = false;
  const areasToInsert = areas.map((area: any) => {
    if (!isValidAreaBounds(area, mapWidth, mapHeight)) return null;
    const isDefaultSpawn = area.type === "spawn" && Boolean(area.isDefaultSpawn) && !defaultSpawnConsumed;
    if (isDefaultSpawn) defaultSpawnConsumed = true;

    return {
      id: typeof area.id === "string" && area.id ? area.id : undefined,
      spaceId,
      name: area.name || "Area",
      type: area.type === "private" ? "room" : (area.type || "public"),
      startX: area.x,
      startY: area.y,
      endX: area.x + area.w,
      endY: area.y + area.h,
      floor: area.floor,
      color: area.color,
      texture: area.texture,
      isDefaultSpawn,
      targetUrl: area.type === "portal" && typeof area.targetUrl === "string" && area.targetUrl.trim() ? area.targetUrl.trim() : undefined,
      targetSpaceId: area.type === "portal" && typeof area.targetSpaceId === "string" && area.targetSpaceId.trim() ? area.targetSpaceId.trim() : undefined,
      targetRoomId: area.type === "portal" && typeof area.targetRoomId === "string" && area.targetRoomId.trim() ? area.targetRoomId.trim() : undefined,
      targetX: area.type === "portal" && Number.isInteger(area.targetX) ? area.targetX : undefined,
      targetY: area.type === "portal" && Number.isInteger(area.targetY) ? area.targetY : undefined,
    };
  }).filter((area: any): area is NonNullable<typeof area> => area !== null);

  if (areasToInsert.length > 0) {
    await client.privateZone.createMany({ data: areasToInsert });
  }
}

function isValidAreaBounds(area: any, width: number, height: number) {
  return Number.isInteger(area?.x) &&
    Number.isInteger(area?.y) &&
    Number.isInteger(area?.w) &&
    Number.isInteger(area?.h) &&
    area.w > 0 &&
    area.h > 0 &&
    area.x >= 0 &&
    area.y >= 0 &&
    area.x + area.w <= width &&
    area.y + area.h <= height;
}

async function createMapVersion(spaceId: string, data: any, userId: string) {
  const latestVersion = await (client as any).spaceMapVersion.findFirst({
    where: { spaceId },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  return (client as any).spaceMapVersion.create({
    data: {
      spaceId,
      version: (latestVersion?.version || 0) + 1,
      data,
      createdById: userId,
    },
  });
}
