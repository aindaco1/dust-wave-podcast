import {
  hasAdminRoleForShow,
  requireAdmin,
  type AdminAuthorization,
  type AdminRole
} from "./admin-auth";
import type { PodcastEnv } from "./env";
import { privateJson } from "./http";
import { validIdentifier } from "./validation";

export type AdminEpisode = {
  id: string;
  showId: string;
  durationSeconds: number | null;
  audioKey: string | null;
  audioBytes: number | null;
  audioEtag: string | null;
  audioMimeType: string | null;
  mediaStatus: string;
};

export type AdminEpisodeAuthorization = {
  authorization: AdminAuthorization;
  episode: AdminEpisode;
};

export async function authorizeAdminEpisode(
  request: Request,
  env: PodcastEnv,
  episodeIdValue: string,
  roles: AdminRole[],
  { requireCsrf = false }: { requireCsrf?: boolean } = {}
): Promise<AdminEpisodeAuthorization | Response> {
  const episodeId = validIdentifier(episodeIdValue, "episodeId");
  const auth = await requireAdmin(request, env, {
    allowedRoles: roles,
    requireCsrf
  });
  if (!auth.ok) return auth.response;
  const episode = await env.DB
    .prepare(
      `SELECT
         id, show_id, duration_seconds, audio_key, audio_bytes, audio_etag,
         audio_mime_type, media_status
       FROM episodes
       WHERE id = ?`
    )
    .bind(episodeId)
    .first<{
      id: string;
      show_id: string;
      duration_seconds: number | null;
      audio_key: string | null;
      audio_bytes: number | null;
      audio_etag: string | null;
      audio_mime_type: string | null;
      media_status: string;
    }>();
  if (
    !episode
    || !hasAdminRoleForShow(
      auth.authorization.identity,
      roles,
      episode.show_id
    )
  ) {
    return privateJson(
      request,
      env.ALLOWED_ORIGINS,
      { error: "episode_not_found" },
      { status: 404 }
    );
  }
  return {
    authorization: auth.authorization,
    episode: {
      id: episode.id,
      showId: episode.show_id,
      durationSeconds: episode.duration_seconds,
      audioKey: episode.audio_key,
      audioBytes: episode.audio_bytes,
      audioEtag: episode.audio_etag,
      audioMimeType: episode.audio_mime_type,
      mediaStatus: episode.media_status
    }
  };
}
