import argparse
import asyncio
import csv
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from dotenv import load_dotenv
from telethon import TelegramClient
from telethon.errors import FloodWaitError
from telethon.tl.types import Channel, Chat


@dataclass
class ScrapeConfig:
    channels: list[str]
    keywords: list[str]
    since_days: int
    limit_per_channel: int
    require_keyword_match: bool
    require_media: bool
    output_dir: Path


def load_config(config_path: Path) -> ScrapeConfig:
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    return ScrapeConfig(
        channels=raw.get("channels", []),
        keywords=raw.get("keywords", []),
        since_days=int(raw.get("since_days", 7)),
        limit_per_channel=int(raw.get("limit_per_channel", 500)),
        require_keyword_match=bool(raw.get("require_keyword_match", True)),
        require_media=bool(raw.get("require_media", False)),
        output_dir=Path(raw.get("output_dir", "output")),
    )


def build_keyword_pattern(keywords: Iterable[str]) -> re.Pattern[str] | None:
    cleaned = [re.escape(k.strip()) for k in keywords if k.strip()]
    if not cleaned:
        return None
    return re.compile(r"(" + "|".join(cleaned) + r")", re.IGNORECASE)


def message_permalink(entity: Channel | Chat, message_id: int) -> str:
    username = getattr(entity, "username", None)
    if username:
        return f"https://t.me/{username}/{message_id}"
    return ""


def entity_title(entity: Channel | Chat) -> str:
    return getattr(entity, "title", "") or getattr(entity, "username", "") or str(getattr(entity, "id", ""))


def ensure_credentials() -> tuple[int, str, str]:
    api_id = os.getenv("TG_API_ID", "").strip()
    api_hash = os.getenv("TG_API_HASH", "").strip()
    phone = os.getenv("TG_PHONE", "").strip()
    if not api_id or not api_hash or not phone:
        raise RuntimeError("Missing TG_API_ID / TG_API_HASH / TG_PHONE in environment.")
    return int(api_id), api_hash, phone


async def scrape(config: ScrapeConfig, session_path: Path) -> list[dict]:
    load_dotenv()
    api_id, api_hash, phone = ensure_credentials()
    pattern = build_keyword_pattern(config.keywords)
    cutoff = datetime.now(timezone.utc) - timedelta(days=config.since_days)
    records: list[dict] = []

    async with TelegramClient(str(session_path), api_id, api_hash) as client:
        await client.start(phone=phone)

        for channel_ref in config.channels:
            entity = await client.get_entity(channel_ref)
            title = entity_title(entity)
            print(f"[info] reading {title} ({channel_ref})")

            count = 0
            try:
                async for message in client.iter_messages(entity, limit=config.limit_per_channel):
                    if not message.date:
                        continue
                    message_dt = message.date.astimezone(timezone.utc)
                    if message_dt < cutoff:
                        continue

                    text = (message.message or "").strip()
                    has_media = message.media is not None
                    matched = pattern.search(text) if pattern else None

                    if config.require_keyword_match and pattern and not matched:
                        continue
                    if config.require_media and not has_media:
                        continue

                    records.append(
                        {
                            "channel": title,
                            "channel_ref": channel_ref,
                            "message_id": message.id,
                            "date_utc": message_dt.isoformat(),
                            "text": text,
                            "views": getattr(message, "views", None),
                            "forwards": getattr(message, "forwards", None),
                            "replies": getattr(getattr(message, "replies", None), "replies", None),
                            "has_media": has_media,
                            "matched_keyword": matched.group(0) if matched else "",
                            "permalink": message_permalink(entity, message.id),
                        }
                    )
                    count += 1
            except FloodWaitError as exc:
                print(f"[warn] flood wait on {channel_ref}: {exc.seconds}s")
                raise

            print(f"[info] kept {count} messages from {title}")

    return records


def write_outputs(records: list[dict], output_dir: Path) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_path = output_dir / f"telegram-memes-{timestamp}.json"
    csv_path = output_dir / f"telegram-memes-{timestamp}.csv"

    json_path.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")

    fieldnames = [
        "channel",
        "channel_ref",
        "message_id",
        "date_utc",
        "matched_keyword",
        "has_media",
        "views",
        "forwards",
        "replies",
        "permalink",
        "text",
    ]
    with csv_path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for record in records:
            writer.writerow({key: record.get(key, "") for key in fieldnames})

    return json_path, csv_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape meme-related messages from public Telegram channels/groups.")
    parser.add_argument("--config", default="config.json", help="Path to config JSON.")
    parser.add_argument("--session", default="telegram_public_scraper", help="Telethon session file prefix.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config_path = Path(args.config)
    if not config_path.exists():
        raise FileNotFoundError(f"Config not found: {config_path}")

    config = load_config(config_path)
    if not config.channels:
        raise RuntimeError("Config channels is empty.")

    records = asyncio.run(scrape(config, Path(args.session)))
    json_path, csv_path = write_outputs(records, config.output_dir)
    print(f"[done] wrote {len(records)} records")
    print(f"[done] json: {json_path}")
    print(f"[done] csv : {csv_path}")


if __name__ == "__main__":
    main()
