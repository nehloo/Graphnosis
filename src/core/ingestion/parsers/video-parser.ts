import type { ParsedDocument, ParsedSection } from '@/core/types';

// Video parser: extracts container metadata ($0) with optional transcription framework
// Handles mp4, webm, mkv, avi, mov via music-metadata

export interface VideoParseOptions {
  enableTranscription?: boolean; // Future: Whisper API for audio transcription
}

// $0 path: container metadata extraction (pure JS, no API calls)
export async function parseVideo(
  buffer: Buffer,
  sourceFile: string,
  options: VideoParseOptions = {}
): Promise<ParsedDocument> {
  const sections: ParsedSection[] = [];
  const metadata: Record<string, string | number> = { source: 'video' };

  try {
    const mm = await import('music-metadata');
    const parsed = await mm.parseBuffer(buffer);

    // Duration
    if (parsed.format.duration) {
      const dur = parsed.format.duration;
      const mins = Math.floor(dur / 60);
      const secs = Math.round(dur % 60);
      metadata.durationSeconds = Math.round(dur);
      sections.push({
        title: 'Duration',
        content: `Video duration: ${mins} minutes and ${secs} seconds (${Math.round(dur)} seconds total).`,
        depth: 1,
        children: [],
      });
    }

    // Container and codec info
    const techInfo: string[] = [];
    if (parsed.format.container) {
      techInfo.push(`Container format: ${parsed.format.container}`);
      metadata.container = parsed.format.container;
    }
    if (parsed.format.codec) {
      techInfo.push(`Codec: ${parsed.format.codec}`);
      metadata.codec = parsed.format.codec;
    }
    if (parsed.format.sampleRate) {
      techInfo.push(`Audio sample rate: ${parsed.format.sampleRate} Hz`);
    }
    if (parsed.format.numberOfChannels) {
      techInfo.push(`Audio channels: ${parsed.format.numberOfChannels}`);
    }
    if (parsed.format.bitrate) {
      techInfo.push(`Bitrate: ${Math.round(parsed.format.bitrate / 1000)} kbps`);
      metadata.bitrate = Math.round(parsed.format.bitrate / 1000);
    }

    if (techInfo.length > 0) {
      sections.push({
        title: 'Technical Information',
        content: techInfo.join('. ') + '.',
        depth: 1,
        children: [],
      });
    }

    // Common tags (title, artist, album, etc.)
    const common = parsed.common;
    if (common) {
      const tagInfo: string[] = [];

      if (common.title) { tagInfo.push(`Title: ${common.title}`); metadata.title = common.title; }
      if (common.artist) { tagInfo.push(`Artist: ${common.artist}`); metadata.artist = common.artist; }
      if (common.album) { tagInfo.push(`Album: ${common.album}`); }
      if (common.year) { tagInfo.push(`Year: ${common.year}`); metadata.year = common.year; }
      if (common.genre && common.genre.length > 0) { tagInfo.push(`Genre: ${common.genre.join(', ')}`); }
      if (common.comment && common.comment.length > 0) {
        tagInfo.push(`Comment: ${common.comment.map(c => c.text).join('; ')}`);
      }
      if (common.description && common.description.length > 0) {
        tagInfo.push(`Description: ${common.description.join('; ')}`);
      }

      if (tagInfo.length > 0) {
        sections.push({
          title: 'Embedded Metadata',
          content: tagInfo.join('. ') + '.',
          depth: 1,
          children: [],
        });
      }

      // Copyright / license
      if (common.copyright) {
        sections.push({
          title: 'Copyright',
          content: `Copyright: ${common.copyright}.`,
          depth: 1,
          children: [],
        });
      }
    }
  } catch (err) {
    // Metadata parsing failed
    sections.push({
      title: 'Video File',
      content: `Video file: ${sourceFile}. Size: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB. Metadata extraction not available for this format.`,
      depth: 1,
      children: [],
    });
  }

  // File info
  metadata.fileSize = buffer.length;
  metadata.fileSizeMB = Math.round(buffer.length / (1024 * 1024) * 100) / 100;

  // Filename context
  const filename = sourceFile.split('/').pop() || sourceFile;
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  if (nameWithoutExt.length > 3) {
    sections.push({
      title: 'Filename Context',
      content: `Video filename suggests: ${nameWithoutExt}.`,
      depth: 1,
      children: [],
    });
  }

  // Transcription framework (future extension point)
  if (options.enableTranscription && process.env.OPENAI_API_KEY) {
    sections.push({
      title: 'Transcription',
      content: 'Audio transcription via Whisper API is a planned feature. Currently, the framework is in place but requires ffmpeg for audio extraction from video containers. Contribute at github.com/nehloo/graphAI.',
      depth: 1,
      children: [],
    });
  }

  // Fallback
  if (sections.length === 0) {
    sections.push({
      title: 'Video',
      content: `Video file: ${sourceFile}. Size: ${(buffer.length / (1024 * 1024)).toFixed(1)} MB.`,
      depth: 1,
      children: [],
    });
  }

  return {
    title: metadata.title as string || nameWithoutExt || 'Video',
    sections,
    sourceFile,
    metadata,
  };
}

// Parse SRT/VTT subtitle files into sections
export function parseSubtitles(content: string, sourceFile: string): ParsedDocument {
  const sections: ParsedSection[] = [];
  const lines = content.split('\n');
  const textBlocks: string[] = [];

  // Simple SRT/VTT parser — extract just the text, skip timestamps
  let currentBlock = '';
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip timestamp lines, sequence numbers, and WEBVTT header
    if (/^\d+$/.test(trimmed)) continue;
    if (/-->/.test(trimmed)) continue;
    if (trimmed === 'WEBVTT') continue;
    if (trimmed === '') {
      if (currentBlock) {
        textBlocks.push(currentBlock);
        currentBlock = '';
      }
      continue;
    }
    currentBlock += (currentBlock ? ' ' : '') + trimmed;
  }
  if (currentBlock) textBlocks.push(currentBlock);

  // Group into sections of ~10 blocks each
  const batchSize = 10;
  for (let i = 0; i < textBlocks.length; i += batchSize) {
    const batch = textBlocks.slice(i, i + batchSize);
    sections.push({
      title: `Transcript ${i + 1}-${Math.min(i + batchSize, textBlocks.length)}`,
      content: batch.join(' '),
      depth: 1,
      children: [],
    });
  }

  return {
    title: sourceFile.replace(/\.(srt|vtt)$/i, ''),
    sections,
    sourceFile,
    metadata: {
      source: 'subtitle',
      blockCount: textBlocks.length,
    },
  };
}
