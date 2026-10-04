import client from "@repo/db/client";
import type { User } from "./User";
import { OutgoingMessage } from "./types";
import { RealtimeBus } from "./RealtimeBus";
import { SpaceBoundsService } from "./services/SpaceBoundsService";
import {
  arePeersInAudioRange,
  getAudioRoomAt,
  getSeatAt,
  getSeatsInRoom,
  isInsideZone,
  type SpatialPeer,
} from "./services/spatialRules";
import { writeRoomSessionEvent } from "./services/eventPersistence";

type PresencePeer = SpatialPeer & {
  id: string;
  userId?: string;
  username?: string;
  avatarUrl?: string;
  status?: "available" | "busy" | "focus" | "away";
  x: number;
  y: number;
};

type RoomSessionMember = {
  userId?: string;
  username?: string;
  avatarUrl?: string;
  status?: "available" | "busy" | "focus" | "away";
};

type GroupLead = {
  userId: string;
  username?: string;
  startedAt: string;
};

export class RoomManager {
  rooms: Map<string, User[]> = new Map();
  zones: Map<string, any[]> = new Map();
  remotePeers: Map<string, Map<string, PresencePeer>> = new Map();
  roomSessions: Map<string, Map<string, Map<string, RoomSessionMember>>> = new Map();
  groupLeads: Map<string, GroupLead> = new Map();
  static instance: RoomManager;
  private spaceBounds = new SpaceBoundsService();

  private constructor() {
    this.rooms = new Map();
    RealtimeBus.getInstance().onEvent((event) => {
      if (event.kind === "broadcast") this.handleRemoteBroadcast(event.spaceId, event.senderConnectionId, event.message);
    });
  }

  static getInstance() {
    if (!this.instance) {
      this.instance = new RoomManager();
    }
    return this.instance;
  }

  public removeUser(user: User, spaceId: string) {
    this.leaveRoomSession(user, spaceId);
    if (!this.rooms.has(spaceId)) {
      return;
    }
    this.rooms.set(
      spaceId,
      this.rooms.get(spaceId)?.filter((u) => u.id !== user.id) ?? [],
    );
    if ((this.rooms.get(spaceId)?.length ?? 0) === 0) {
      this.rooms.delete(spaceId);
      this.zones.delete(spaceId);
      this.spaceBounds.clear(spaceId);
      this.remotePeers.delete(spaceId);
      this.roomSessions.delete(spaceId);
      this.groupLeads.delete(spaceId);
      RealtimeBus.getInstance().releaseSpaceOwner(spaceId);
    }
  }

  public async addUser(spaceId: string, user: User) {
    const owner = await RealtimeBus.getInstance().claimSpaceOwner(spaceId);
    if (!owner.ok) {
      return { ok: false, reason: "sfu-owned-by-other-instance", ownerInstanceId: owner.ownerInstanceId, redirectUrl: owner.ownerPublicUrl };
    }
    RealtimeBus.getInstance().subscribeSpace(spaceId);
    const current = this.rooms.get(spaceId) ?? [];
    if (current.some((u) => u.id === user.id)) return { ok: true };
    if (!this.rooms.has(spaceId)) {
      this.rooms.set(spaceId, [user]);
      return { ok: true };
    }
    this.rooms.set(spaceId, [...(this.rooms.get(spaceId) ?? []), user]);
    return { ok: true };
  }

  public broadcast(message: OutgoingMessage, user: User, roomId: string) {
    RealtimeBus.getInstance().publishBroadcast(roomId, message, { id: user.id, userId: user.userId });
    if (!this.rooms.has(roomId)) return;
    this.rooms.get(roomId)?.forEach((u) => {
      if (u.id !== user.id) {
        u.send(message);
      }
    });
  }

  public sendToUsers(message: OutgoingMessage, roomId: string, predicate: (user: User) => boolean) {
    if (!this.rooms.has(roomId)) return;
    this.rooms.get(roomId)?.forEach((u) => {
      if (predicate(u)) u.send(message);
    });
  }

  public findUserByUserId(spaceId: string, userId: string) {
    return this.rooms.get(spaceId)?.find((user) => user.userId === userId);
  }

  public serializeUsers(spaceId: string, excludeConnectionId?: string) {
    return this.rooms.get(spaceId)
      ?.filter((user) => user.id !== excludeConnectionId)
      .map((user) => ({
        id: user.id,
        userId: user.userId,
        username: user.username,
        avatarUrl: user.avatarUrl,
        status: user.status,
        x: user.x,
        y: user.y,
      })) ?? [];
  }

  public serializeRoomSessions(spaceId: string) {
    const sessions = this.roomSessions.get(spaceId);
    if (!sessions) return [];
    return Array.from(sessions.entries()).map(([roomId, members]) => {
      const room = (this.zones.get(spaceId) || []).find((zone) => zone.id === roomId);
      return {
        roomId,
        name: room?.name,
        members: Array.from(members.values()),
      };
    });
  }

  public getGroupLead(spaceId: string) {
    return this.groupLeads.get(spaceId) || null;
  }

  public setGroupLead(user: User, enabled: boolean) {
    if (!user.spaceId || !user.userId) return;

    const lead = enabled
      ? { userId: user.userId, username: user.username, startedAt: new Date().toISOString() }
      : null;

    if (lead) {
      this.groupLeads.set(user.spaceId, lead);
    } else if (this.groupLeads.get(user.spaceId)?.userId === user.userId) {
      this.groupLeads.delete(user.spaceId);
    } else {
      return;
    }

    this.broadcastGroupLead(user.spaceId, lead);
  }

  public updateRoomSession(user: User) {
    if (!user.spaceId) return;
    const room = this.getAudioRoomAt(user.spaceId, user.x, user.y);
    const nextRoomId = room?.id;
    const previousRoomId = user.currentRoomId;

    if (previousRoomId && previousRoomId !== nextRoomId) {
      this.removeRoomSessionMember(user.spaceId, previousRoomId, user.userId);
    }

    if (nextRoomId) {
      if (!this.roomSessions.has(user.spaceId)) this.roomSessions.set(user.spaceId, new Map());
      const sessions = this.roomSessions.get(user.spaceId)!;
      if (!sessions.has(nextRoomId)) sessions.set(nextRoomId, new Map());
      sessions.get(nextRoomId)!.set(user.userId || user.id, {
        userId: user.userId,
        username: user.username,
        avatarUrl: user.avatarUrl,
        status: user.status,
      });
    }

    user.currentRoomId = nextRoomId;

    if (previousRoomId !== nextRoomId) {
      const eventType = previousRoomId && nextRoomId ? "moved" : nextRoomId ? "joined" : "left";
      void writeRoomSessionEvent({
        spaceId: user.spaceId,
        roomId: nextRoomId || previousRoomId,
        roomName: room?.name || this.findZoneName(user.spaceId, previousRoomId),
        eventType,
        userId: user.userId,
        username: user.username,
        previousRoomId,
      });
      this.broadcastRoomSessions(user.spaceId);
      user.send({
        type: "room-session-current",
        payload: {
          roomId: nextRoomId || null,
          previousRoomId: previousRoomId || null,
          roomName: room?.name,
        },
      });
    }
  }

  public leaveRoomSession(user: User, spaceId: string) {
    if (!user.currentRoomId) return;
    const previousRoomId = user.currentRoomId;
    this.removeRoomSessionMember(spaceId, user.currentRoomId, user.userId);
    user.currentRoomId = undefined;
    void writeRoomSessionEvent({
      spaceId,
      roomId: previousRoomId,
      roomName: this.findZoneName(spaceId, previousRoomId),
      eventType: "left",
      userId: user.userId,
      username: user.username,
      previousRoomId,
    });
    this.broadcastRoomSessions(spaceId);
  }

  public clearGroupLeadForUser(user: User, spaceId: string) {
    if (!user.userId) return;
    if (this.groupLeads.get(spaceId)?.userId !== user.userId) return;
    this.groupLeads.delete(spaceId);
    this.broadcastGroupLead(spaceId, null);
  }

  private removeRoomSessionMember(spaceId: string, roomId: string, userId?: string) {
    const sessions = this.roomSessions.get(spaceId);
    if (!sessions) return;
    const members = sessions.get(roomId);
    if (!members) return;
    members.delete(userId || "");
    if (members.size === 0) sessions.delete(roomId);
    if (sessions.size === 0) this.roomSessions.delete(spaceId);
  }

  private broadcastRoomSessions(spaceId: string) {
    const message = {
      type: "room-session-updated",
      payload: {
        sessions: this.serializeRoomSessions(spaceId),
      },
    };
    this.rooms.get(spaceId)?.forEach((user) => user.send(message));
  }

  private broadcastGroupLead(spaceId: string, lead: GroupLead | null) {
    const message = {
      type: "group-lead-updated",
      payload: { lead },
    };
    this.rooms.get(spaceId)?.forEach((user) => user.send(message));
  }

  private findZoneName(spaceId: string, roomId?: string) {
    if (!roomId) return undefined;
    return (this.zones.get(spaceId) || []).find((zone) => zone.id === roomId)?.name;
  }

  private handleRemoteBroadcast(spaceId: string, senderConnectionId: string | undefined, message: OutgoingMessage) {
    this.trackRemotePresence(spaceId, senderConnectionId, message);
    this.rooms.get(spaceId)?.forEach((user) => {
      if (senderConnectionId && user.id === senderConnectionId) return;
      user.send(message);
    });
    this.recheckLocalProximity(spaceId);
  }

  private trackRemotePresence(spaceId: string, senderConnectionId: string | undefined, message: OutgoingMessage) {
    if (!senderConnectionId) return;
    if (!this.remotePeers.has(spaceId)) this.remotePeers.set(spaceId, new Map());
    const peers = this.remotePeers.get(spaceId)!;

    if (message?.type === "user-left") {
      peers.delete(senderConnectionId);
      return;
    }

    const payload = message?.payload || {};
    if (message?.type === "user-joined") {
      peers.set(senderConnectionId, {
        id: senderConnectionId,
        userId: payload.userId,
        username: payload.username,
        avatarUrl: payload.avatarUrl,
        status: payload.status || "available",
        x: payload.x,
        y: payload.y,
      });
      return;
    }

    if (message?.type === "movement") {
      const existing = peers.get(senderConnectionId);
      peers.set(senderConnectionId, {
        id: senderConnectionId,
        userId: payload.userId || existing?.userId,
        username: existing?.username,
        avatarUrl: existing?.avatarUrl,
        status: existing?.status || "available",
        x: payload.x,
        y: payload.y,
      });
      return;
    }

    if (message?.type === "status-update") {
      const existing = peers.get(senderConnectionId);
      if (existing) peers.set(senderConnectionId, { ...existing, status: payload.status || existing.status });
    }
  }

  public async loadSpaceZones(spaceId: string) {
    if (this.zones.has(spaceId)) return;
    const space = await client.space.findUnique({
      where: { id: spaceId },
      select: {
        width: true,
        height: true,
        privateZones: true,
      },
    });
    this.zones.set(spaceId, this.sanitizeZones(space?.privateZones || [], space?.width || 0, space?.height || 0));
  }

  public clearSpaceBounds(spaceId: string) {
    this.spaceBounds.clear(spaceId);
  }

  private sanitizeZones(zones: any[], width: number, height: number) {
    return zones
      .map((zone) => ({ ...zone, type: this.normalizeZoneType(zone) }))
      .filter((zone) =>
        Number.isInteger(zone.startX) &&
        Number.isInteger(zone.startY) &&
        Number.isInteger(zone.endX) &&
        Number.isInteger(zone.endY) &&
        zone.startX >= 0 &&
        zone.startY >= 0 &&
        zone.endX > zone.startX &&
        zone.endY > zone.startY &&
        zone.endX <= width &&
        zone.endY <= height
      );
  }

  private normalizeZoneType(zone: any) {
    const text = `${zone.name || ""} ${zone.type || ""}`.toLowerCase();
    if (text.includes("portal")) return "portal";
    if (text.includes("spawn")) return "spawn";
    if (text.includes("spotlight")) return "spotlight";
    if (text === "spot" || text.includes(" spot")) return "seat";
    if (zone.type === "private") return "room";
    return zone.type || "public";
  }

  public async loadSpaceBounds(spaceId: string, forceReload = false) {
    return this.spaceBounds.load(spaceId, forceReload);
  }

  public async canOccupy(spaceId: string, x: number, y: number) {
    return this.spaceBounds.canOccupy(spaceId, x, y);
  }

  public getAudioRoomAt(spaceId: string, x: number, y: number) {
    return getAudioRoomAt(this.zones.get(spaceId) || [], x, y);
  }

  public getSeatAt(spaceId: string, x: number, y: number) {
    return getSeatAt(this.zones.get(spaceId) || [], x, y);
  }

  public getSeatsInRoom(spaceId: string, room: any) {
    return getSeatsInRoom(this.zones.get(spaceId) || [], room);
  }

  private getPresencePeers(spaceId: string): Array<PresencePeer | User> {
    const localPeers = this.rooms.get(spaceId) || [];
    const remotePeers = Array.from(this.remotePeers.get(spaceId)?.values() || []);
    return [...localPeers, ...remotePeers];
  }

  public canEnterDynamic(user: User, x: number, y: number): { ok: boolean; reason?: string } {
    if (!user.spaceId) return { ok: false, reason: 'not-in-space' };
    const users = this.rooms.get(user.spaceId) || [];
    const targetSeat = this.getSeatAt(user.spaceId, x, y);

    if (targetSeat) {
      const occupied = users.some((other) =>
        other.id !== user.id &&
        isInsideZone(other.x, other.y, targetSeat)
      );
      if (occupied) return { ok: false, reason: 'spot-occupied' };
    }

    const targetRoom = this.getAudioRoomAt(user.spaceId, x, y);
    const currentRoom = this.getAudioRoomAt(user.spaceId, user.x, user.y);
    if (!targetRoom || currentRoom?.id === targetRoom.id) return { ok: true };

    const seats = this.getSeatsInRoom(user.spaceId, targetRoom);
    if (seats.length === 0) return { ok: true };

    const occupants = users.filter((other) =>
      other.id !== user.id &&
      isInsideZone(other.x, other.y, targetRoom)
    );
    if (occupants.length >= seats.length) {
      return { ok: false, reason: 'room-full' };
    }

    return { ok: true };
  }

  public async canEnterTile(user: User, x: number, y: number): Promise<{ ok: boolean; reason?: string }> {
    if (!user.spaceId) return { ok: false, reason: 'not-in-space' };
    let canOccupyStatic = await this.canOccupy(user.spaceId, x, y);
    if (!canOccupyStatic) {
      await this.loadSpaceBounds(user.spaceId, true);
      canOccupyStatic = await this.canOccupy(user.spaceId, x, y);
    }
    if (!canOccupyStatic) return { ok: false, reason: 'blocked' };
    return this.canEnterDynamic(user, x, y);
  }

  public checkProximity(user: User, spaceId: string) {
    const peers = this.getPresencePeers(spaceId);
    peers.forEach((otherUser) => {
      if (user.id === otherUser.id) return;
      const inRange = arePeersInAudioRange(this.zones.get(spaceId) || [], user, otherUser);
      const alreadyInProximity = user.inProximityWith.has(otherUser.id);

      if (inRange && !alreadyInProximity) {
        user.inProximityWith.add(otherUser.id);

        user.send({
          type: "proximity-entered",
          payload: { userId: otherUser.userId },
        });
        if (otherUser instanceof Object && "send" in otherUser && typeof (otherUser as any).send === "function") {
          (otherUser as User).inProximityWith.add(user.id);
          (otherUser as User).send({
            type: "proximity-entered",
            payload: { userId: user.userId },
          });
        }
      } else if (!inRange && alreadyInProximity) {
        user.inProximityWith.delete(otherUser.id);

        user.send({
          type: "proximity-left",
          payload: { userId: otherUser.userId },
        });
        if (otherUser instanceof Object && "send" in otherUser && typeof (otherUser as any).send === "function") {
          (otherUser as User).inProximityWith.delete(user.id);
          (otherUser as User).send({
            type: "proximity-left",
            payload: { userId: user.userId },
          });
        }
      }
    });
  }

  private recheckLocalProximity(spaceId: string) {
    this.rooms.get(spaceId)?.forEach((user) => this.checkProximity(user, spaceId));
  }
}
