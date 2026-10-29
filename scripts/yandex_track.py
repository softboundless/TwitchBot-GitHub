#!/usr/bin/env python3
"""Return current Yandex Music playback state as one JSON line.

The OAuth token is accepted only through stdin so it doesn't appear in the
process list. This helper is intentionally small: Twitch-facing formatting and
cooldown live in the Node.js bot.
"""

import json
import random
import socket
import sys
import urllib.parse
import uuid
from typing import Any

from yandex_music import Client
from yandex_music.ynison import simple
from websockets.sync.client import connect


def force_ipv4() -> None:
    """Work around the VPS advertising IPv6 without a working IPv6 route."""

    original_getaddrinfo = socket.getaddrinfo

    def ipv4_getaddrinfo(
        host: str,
        port: int,
        family: int = 0,
        type: int = 0,
        proto: int = 0,
        flags: int = 0,
    ) -> list[Any]:
        return original_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)

    socket.getaddrinfo = ipv4_getaddrinfo


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def legacy_protocols(info: dict[str, str]) -> list[str]:
    return ["Bearer", "v2", urllib.parse.quote(json.dumps(info, separators=(",", ":")))]


def legacy_current_playable_id(token: str) -> str | None:
    """Fallback for browser sessions that don't appear to a remote-controller client."""

    device_id = "pcflbot-track-legacy"
    info = {
        "Ynison-Device-Id": device_id,
        "Ynison-Device-Info": json.dumps({"app_name": "Chrome", "type": "1"}, separators=(",", ":")),
    }
    headers = {
        "Origin": "https://music.yandex.ru",
        "Authorization": f"OAuth {token}",
    }
    redirect_url = (
        "wss://ynison.music.yandex.ru/"
        "redirector.YnisonRedirectService/GetRedirectToYnison"
    )
    with connect(
        redirect_url,
        additional_headers=headers,
        subprotocols=legacy_protocols(info),
        open_timeout=10,
        close_timeout=1,
    ) as websocket:
        redirect = json.loads(websocket.recv(timeout=12))

    host = redirect.get("host")
    ticket = redirect.get("redirect_ticket")
    session_id = redirect.get("session_id")
    if not host or not ticket:
        raise RuntimeError("invalid Ynison redirect response")

    state_info = {
        **info,
        "Ynison-Redirect-Ticket": ticket,
    }
    if session_id is not None:
        state_info["Ynison-Session-Id"] = str(session_id)

    def version() -> dict[str, Any]:
        return {
            "device_id": device_id,
            "version": random.randrange(10**18, 9 * 10**18),
            "timestamp_ms": 0,
        }

    request = {
        "update_full_state": {
            "player_state": {
                "player_queue": {
                    "current_playable_index": -1,
                    "entity_id": "",
                    "entity_type": "VARIOUS",
                    "playable_list": [],
                    "options": {"repeat_mode": "NONE"},
                    "entity_context": "BASED_ON_ENTITY_BY_DEFAULT",
                    "version": version(),
                    "from_optional": "",
                },
                "status": {
                    "duration_ms": 0,
                    "paused": True,
                    "playback_speed": 1,
                    "progress_ms": 0,
                    "version": version(),
                },
            },
            "device": {
                "capabilities": {
                    "can_be_player": True,
                    "can_be_remote_controller": False,
                    "volume_granularity": 16,
                },
                "info": {
                    "device_id": device_id,
                    "type": "WEB",
                    "title": "PeeacefullBot shadow player",
                    "app_name": "Chrome",
                },
                "volume_info": {"volume": 0},
                "is_shadow": True,
            },
            "is_currently_active": False,
        },
        "rid": str(uuid.uuid4()),
        "player_action_timestamp_ms": 0,
        "activity_interception_type": "DO_NOT_INTERCEPT_BY_DEFAULT",
    }
    state_url = f"wss://{host}/ynison_state.YnisonStateService/PutYnisonState"
    with connect(
        state_url,
        additional_headers=headers,
        subprotocols=legacy_protocols(state_info),
        open_timeout=10,
        close_timeout=1,
    ) as websocket:
        websocket.send(json.dumps(request, separators=(",", ":")))
        state = json.loads(websocket.recv(timeout=12))

    player_state = state.get("player_state") or {}
    queue = player_state.get("player_queue") or {}
    status = player_state.get("status") or {}
    index = queue.get("current_playable_index", -1)
    playable_list = queue.get("playable_list") or []
    if status.get("paused", True) or not isinstance(index, int) or not 0 <= index < len(playable_list):
        return None
    return str(playable_list[index].get("playable_id") or "") or None


def main() -> int:
    token = sys.stdin.readline().strip()
    if not token:
        emit({"status": "error", "error": "YANDEX_MUSIC_TOKEN is empty"})
        return 2

    force_ipv4()

    try:
        state = simple.get_state(token, device_id="pcflbot-track", timeout=12.0)
        queue = state.player_state.player_queue
        status = state.player_state.status
        index = queue.current_playable_index
        playable = queue.playable_list[index] if 0 <= index < len(queue.playable_list) else None

        playable_id = None
        source = "ynison"
        if state.active_device_id_optional and not status.paused and playable is not None:
            playable_id = playable.playable_id
        if not playable_id:
            playable_id = legacy_current_playable_id(token)
            source = "ynison-legacy"
        if not playable_id:
            emit({"status": "idle"})
            return 0

        tracks = Client(token).tracks(playable_id)
        track = tracks[0] if tracks else None
        if track is None or not track.title:
            emit({"status": "error", "error": "track metadata not found"})
            return 3

        artists = ", ".join(artist.name for artist in track.artists if artist.name)
        emit({"status": "playing", "artist": artists, "title": track.title, "source": source})
        return 0
    except Exception as error:  # the bot logs the type, never the token
        print(f"{type(error).__name__}: {error}", file=sys.stderr, flush=True)
        emit({"status": "error", "error": type(error).__name__})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
