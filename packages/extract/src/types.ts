export interface Box { x: number; y: number; w: number; h: number } // pixels on the page image
export interface ExtractedFieldOut {
  key: string;
  raw: string;
  value: string | null;
  confidence: number | null; // OCR engine estimate 0..1, NOT a probability of correctness
  page: number;
  box: Box;
  errors: string[];
}
export interface ParcelOut { index: number; fields: ExtractedFieldOut[] }
export interface ExtractionResult {
  templateId: string;
  fields: ExtractedFieldOut[];
  parcels: ParcelOut[];
  photoJpeg: Buffer | null;
  warnings: string[];
}
export interface PageImage { pageNo: number; png: Buffer; width: number; height: number }
export interface ExtractorOptions {
  tesseractBin: string;
  tessdataDir: string;
}
