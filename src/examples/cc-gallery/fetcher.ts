import type { ParsedDocument, ParsedSection } from '@/core/types';
import { CC_IMAGES, WIKIMEDIA_API_BASE } from './config';

// Fetch Creative Commons images from Wikimedia Commons
// Uses the API to get metadata — doesn't download full images (saves bandwidth)

interface WikimediaImageInfo {
  title: string;
  url: string;
  descriptionurl: string;
  width: number;
  height: number;
  size: number;
  mime: string;
  extmetadata?: {
    ImageDescription?: { value: string };
    DateTimeOriginal?: { value: string };
    Artist?: { value: string };
    LicenseShortName?: { value: string };
    GPSLatitude?: { value: string };
    GPSLongitude?: { value: string };
    Categories?: { value: string };
    ObjectName?: { value: string };
  };
}

async function fetchImageInfo(title: string): Promise<WikimediaImageInfo | null> {
  try {
    const params = new URLSearchParams({
      action: 'query',
      titles: title,
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      format: 'json',
      origin: '*',
    });

    const res = await fetch(`${WIKIMEDIA_API_BASE}?${params}`);
    if (!res.ok) return null;

    const data = await res.json();
    const pages = data.query?.pages;
    if (!pages) return null;

    const page = Object.values(pages)[0] as { imageinfo?: WikimediaImageInfo[] };
    if (!page.imageinfo || page.imageinfo.length === 0) return null;

    return { ...page.imageinfo[0], title };
  } catch {
    return null;
  }
}

function imageInfoToDocument(
  info: WikimediaImageInfo,
  configImage: typeof CC_IMAGES[0]
): ParsedDocument {
  const sections: ParsedSection[] = [];
  const ext = info.extmetadata || {};

  // Description
  const description = ext.ImageDescription?.value
    ? stripHtml(ext.ImageDescription.value)
    : configImage.description;

  sections.push({
    title: 'Description',
    content: description,
    depth: 1,
    children: [],
  });

  // Image dimensions and technical info
  sections.push({
    title: 'Technical Details',
    content: `Image dimensions: ${info.width}x${info.height} pixels. File size: ${(info.size / 1024).toFixed(0)} KB. Format: ${info.mime}. Category: ${configImage.category}.`,
    depth: 1,
    children: [],
  });

  // Date
  if (ext.DateTimeOriginal?.value) {
    sections.push({
      title: 'Date',
      content: `Created or captured: ${ext.DateTimeOriginal.value}.`,
      depth: 1,
      children: [],
    });
  }

  // Artist / attribution
  if (ext.Artist?.value) {
    sections.push({
      title: 'Attribution',
      content: `Creator: ${stripHtml(ext.Artist.value)}.`,
      depth: 1,
      children: [],
    });
  }

  // License
  const license = ext.LicenseShortName?.value || configImage.license;
  sections.push({
    title: 'License',
    content: `License: ${license}. Source: Wikimedia Commons.`,
    depth: 1,
    children: [],
  });

  // GPS if available
  if (ext.GPSLatitude?.value && ext.GPSLongitude?.value) {
    sections.push({
      title: 'Location',
      content: `GPS coordinates: ${ext.GPSLatitude.value}, ${ext.GPSLongitude.value}.`,
      depth: 1,
      children: [],
    });
  }

  // Categories
  if (ext.Categories?.value) {
    sections.push({
      title: 'Categories',
      content: `Wikimedia categories: ${ext.Categories.value}.`,
      depth: 1,
      children: [],
    });
  }

  return {
    title: configImage.description || info.title.replace('File:', ''),
    sections,
    sourceFile: `cc-gallery:${info.title}`,
    metadata: {
      source: 'cc-gallery',
      license,
      width: info.width,
      height: info.height,
      fileSize: info.size,
      mime: info.mime,
      category: configImage.category,
      url: info.descriptionurl || '',
    },
  };
}

export async function fetchAllCCImages(
  onProgress?: (current: number, total: number, title: string) => void
): Promise<ParsedDocument[]> {
  const documents: ParsedDocument[] = [];
  const total = CC_IMAGES.length;

  for (let i = 0; i < total; i++) {
    const config = CC_IMAGES[i];
    onProgress?.(i + 1, total, config.description);

    const info = await fetchImageInfo(config.title);
    if (info) {
      documents.push(imageInfoToDocument(info, config));
    }

    // Be gentle with Wikimedia API
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return documents;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
}
