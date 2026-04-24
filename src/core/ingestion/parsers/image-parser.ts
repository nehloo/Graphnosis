import type { ParsedDocument, ParsedSection } from '@/core/types';

// Image parser: extracts EXIF metadata ($0) with optional vision API support
// Handles JPEG, TIFF, PNG (EXIF only in JPEG/TIFF)

export interface ImageParseOptions {
  enableVision?: boolean; // If true and OPENAI_API_KEY set, use vision API
}

// $0 path: EXIF metadata extraction (pure JS, no API calls)
export async function parseImage(
  buffer: Buffer,
  sourceFile: string,
  options: ImageParseOptions = {}
): Promise<ParsedDocument> {
  const sections: ParsedSection[] = [];
  const metadata: Record<string, string | number> = { source: 'image' };

  // Extract EXIF data
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ExifParser = require('exif-parser');
    const parser = ExifParser.create(buffer);
    parser.enableBinaryFields(false);
    const exifData = parser.parse();

    // Basic image info
    if (exifData.imageSize) {
      metadata.width = exifData.imageSize.width || 0;
      metadata.height = exifData.imageSize.height || 0;
      sections.push({
        title: 'Image Dimensions',
        content: `Image is ${metadata.width}x${metadata.height} pixels.`,
        depth: 1,
        children: [],
      });
    }

    // Camera info
    const tags = exifData.tags || {};
    const cameraInfo: string[] = [];

    if (tags.Make) { cameraInfo.push(`Camera make: ${tags.Make}`); metadata.cameraMake = tags.Make; }
    if (tags.Model) { cameraInfo.push(`Camera model: ${tags.Model}`); metadata.cameraModel = tags.Model; }
    if (tags.ExposureTime) cameraInfo.push(`Shutter speed: ${tags.ExposureTime}s`);
    if (tags.FNumber) cameraInfo.push(`Aperture: f/${tags.FNumber}`);
    if (tags.ISO || tags.ISOSpeedRatings) {
      const iso = tags.ISO || tags.ISOSpeedRatings;
      cameraInfo.push(`ISO: ${iso}`);
      metadata.iso = iso;
    }
    if (tags.FocalLength) cameraInfo.push(`Focal length: ${tags.FocalLength}mm`);
    if (tags.LensModel) cameraInfo.push(`Lens: ${tags.LensModel}`);

    if (cameraInfo.length > 0) {
      sections.push({
        title: 'Camera Information',
        content: cameraInfo.join('. ') + '.',
        depth: 1,
        children: [],
      });
    }

    // Date info
    if (tags.DateTimeOriginal) {
      const date = new Date(tags.DateTimeOriginal * 1000).toISOString();
      metadata.dateTaken = date;
      sections.push({
        title: 'Date Taken',
        content: `This image was captured on ${date}.`,
        depth: 1,
        children: [],
      });
    }

    // GPS location
    if (tags.GPSLatitude && tags.GPSLongitude) {
      metadata.latitude = tags.GPSLatitude;
      metadata.longitude = tags.GPSLongitude;
      const lat = tags.GPSLatitude.toFixed(6);
      const lon = tags.GPSLongitude.toFixed(6);
      sections.push({
        title: 'Location',
        content: `Image was taken at GPS coordinates: latitude ${lat}, longitude ${lon}.${tags.GPSAltitude ? ` Altitude: ${tags.GPSAltitude.toFixed(1)}m.` : ''}`,
        depth: 1,
        children: [],
      });
    }

    // Software / processing info
    if (tags.Software) {
      sections.push({
        title: 'Software',
        content: `Processed with: ${tags.Software}.`,
        depth: 1,
        children: [],
      });
    }

    // Image description (some cameras embed this)
    if (tags.ImageDescription) {
      sections.push({
        title: 'Embedded Description',
        content: tags.ImageDescription,
        depth: 1,
        children: [],
      });
    }

    // Artist / copyright
    if (tags.Artist || tags.Copyright) {
      const parts: string[] = [];
      if (tags.Artist) parts.push(`Artist: ${tags.Artist}`);
      if (tags.Copyright) parts.push(`Copyright: ${tags.Copyright}`);
      sections.push({
        title: 'Attribution',
        content: parts.join('. ') + '.',
        depth: 1,
        children: [],
      });
    }
  } catch {
    // EXIF parsing failed (PNG without EXIF, corrupted data, etc.)
    sections.push({
      title: 'Metadata',
      content: `Image file: ${sourceFile}. Size: ${buffer.length} bytes. EXIF data not available for this image format.`,
      depth: 1,
      children: [],
    });
  }

  // Extract filename context
  const filename = sourceFile.split('/').pop() || sourceFile;
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  if (nameWithoutExt.length > 3) {
    sections.push({
      title: 'Filename Context',
      content: `Image filename suggests: ${nameWithoutExt}.`,
      depth: 1,
      children: [],
    });
  }

  metadata.fileSize = buffer.length;

  // Optional: Vision API for content description
  if (options.enableVision && process.env.OPENAI_API_KEY) {
    try {
      const visionSections = await analyzeWithVision(buffer, sourceFile);
      sections.push(...visionSections);
      metadata.visionAnalyzed = 1;
    } catch (err) {
      console.error(`Vision analysis failed for ${sourceFile}:`, err);
    }
  }

  // Fallback: ensure at least one section exists
  if (sections.length === 0) {
    sections.push({
      title: 'Image',
      content: `Image file: ${sourceFile}. Size: ${(buffer.length / 1024).toFixed(1)} KB.`,
      depth: 1,
      children: [],
    });
  }

  return {
    title: nameWithoutExt || 'Image',
    sections,
    sourceFile,
    metadata,
  };
}

// Optional vision API analysis — requires OPENAI_API_KEY
async function analyzeWithVision(buffer: Buffer, sourceFile: string): Promise<ParsedSection[]> {
  const { openai } = await import('@ai-sdk/openai');
  const { generateText } = await import('ai');

  const base64 = buffer.toString('base64');
  const mimeType = sourceFile.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const result = await generateText({
    model: openai('gpt-4o-mini'),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Analyze this image. Respond in JSON with: {"description": "2-3 sentence scene description", "objects": ["list", "of", "detected", "objects"], "text": "any text visible in the image or empty string", "mood": "overall mood/atmosphere"}',
          },
          {
            type: 'image',
            image: `data:${mimeType};base64,${base64}`,
          },
        ],
      },
    ],
    maxOutputTokens: 300,
  });

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    const sections: ParsedSection[] = [];

    if (parsed.description) {
      sections.push({
        title: 'Visual Description',
        content: parsed.description,
        depth: 1,
        children: [],
      });
    }

    if (parsed.objects && parsed.objects.length > 0) {
      sections.push({
        title: 'Detected Objects',
        content: `Objects in image: ${parsed.objects.join(', ')}.`,
        depth: 1,
        children: [],
      });
    }

    if (parsed.text && parsed.text.length > 0) {
      sections.push({
        title: 'Text Content (OCR)',
        content: parsed.text,
        depth: 1,
        children: [],
      });
    }

    return sections;
  } catch {
    return [];
  }
}
