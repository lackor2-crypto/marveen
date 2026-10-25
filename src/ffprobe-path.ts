// #789: where ffprobe is expected: beside the ffmpeg that was found (the same package ships both). One place for the video
// render and the capability check. A leaf module on purpose (node:path only): the capability check imported it from the
// render module before, which closed an import cycle (workbench-video -> workbench-capabilities -> workbench-video-render
// -> workbench-video) and, loaded in that order, left the render timeout NaN -- every render then "timed out" at once.
import { basename, dirname, join } from 'node:path'

export function ffprobeBeside(ffmpegPath: string): string {
  return join(dirname(ffmpegPath), basename(ffmpegPath).replace(/ffmpeg/i, 'ffprobe'))
}
