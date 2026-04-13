// Creative Commons Gallery — images from Wikimedia Commons
// All images are CC BY-SA or CC0 (public domain)
// Fetched via Wikimedia Commons API (no auth required)

export interface CCImage {
  title: string; // Wikimedia Commons file title
  description: string;
  category: string;
  license: string;
}

// Curated set of images with rich metadata and cross-domain relevance
export const CC_IMAGES: CCImage[] = [
  // Space & astronomy
  {
    title: 'File:Apollo 11 first step.jpg',
    description: 'Neil Armstrong takes the first step on the Moon during Apollo 11',
    category: 'Space exploration',
    license: 'Public domain (NASA)',
  },
  {
    title: 'File:Mars Valles Marineris.jpeg',
    description: 'Valles Marineris canyon system on Mars captured by Viking orbiter',
    category: 'Mars',
    license: 'Public domain (NASA)',
  },
  {
    title: 'File:Curiosity Self-Portrait at Big Sky.jpg',
    description: 'NASA Curiosity rover self-portrait on Mars at Big Sky drilling site',
    category: 'Mars',
    license: 'Public domain (NASA/JPL)',
  },
  {
    title: 'File:Hubble ultra deep field.jpg',
    description: 'Hubble Space Telescope Ultra Deep Field showing thousands of galaxies',
    category: 'Astronomy',
    license: 'Public domain (NASA/ESA)',
  },
  // Computing history
  {
    title: 'File:Eniac.jpg',
    description: 'ENIAC, one of the first general-purpose electronic computers, 1946',
    category: 'Computing',
    license: 'Public domain (US Army)',
  },
  {
    title: 'File:Alan Turing Aged 16.jpg',
    description: 'Alan Turing aged 16, passport photo',
    category: 'Computing',
    license: 'Public domain',
  },
  // Nature
  {
    title: 'File:Mount Everest as seen from Drukair2.jpg',
    description: 'Mount Everest aerial view from Drukair flight',
    category: 'Geography',
    license: 'CC BY-SA 2.0',
  },
  {
    title: 'File:Lightning over Oradea Romania 2.jpg',
    description: 'Lightning storm over Oradea, Romania',
    category: 'Nature',
    license: 'CC BY-SA 3.0',
  },
  // Architecture
  {
    title: 'File:Bran Castle (Dracula\'s Castle).jpg',
    description: 'Bran Castle in Transylvania, Romania, often associated with Dracula',
    category: 'Architecture',
    license: 'CC BY-SA 3.0',
  },
  // Science
  {
    title: 'File:DNA Structure+Key+Labelled.pn NoBB.png',
    description: 'Structure of DNA double helix with labeled base pairs',
    category: 'Biology',
    license: 'Public domain',
  },
];

export const WIKIMEDIA_API_BASE = 'https://commons.wikimedia.org/w/api.php';
