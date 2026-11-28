---
name: audio-video-transcribe
description: Use whenever a recording has to be understood - an audio or video file on disk (m4a, mp3, wav, ogg, mp4, mov), a Telegram voice message, audio or video attachment, or a question like "what is said in this file". Every agent can write the speech down; never answer that you cannot process sound or video, and never guess the content from the file name.
scope: global
---

# Speech to text from any recording

## Command

```bash
bash {{PROJECT_ROOT}}/scripts/voice/stt.sh "<path to the file | Telegram file_id>"
```

The transcript is printed to stdout. A file on disk works as it is, videos too (the sound track is read).

- Telegram attachment: either pass its `attachment_file_id`, or download it with the
  `download_attachment` tool and pass the path. If your bot token is not in the default place,
  give your own Telegram state folder as the second argument.
- Long recordings take a while with the local recogniser: run the command in the background and
  carry on; do not cut the file and do not give up on a timeout.
- Language is Hungarian. The engine follows the dashboard Settings (cloud or local).
- Inside a Workbench work item the recordings are transcribed by themselves into the context file:
  read that first.

## If it fails

- "The voice toolkit is not installed": tell the owner to open Settings, Voice, and press install.
  Do not install packages on your own.
- Anything else: report the error message as it is. Never make up what the recording says.

## Check

The output is real sentences. A silent file gives an empty line: say that no speech was heard.
