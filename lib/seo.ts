import type { Metadata } from "next";
export const SITE_URL = "https://cernoia.energeticanika.com";
export const HOME_DESCRIPTION = "Encuentra oportunidades en SECOP, analiza requisitos con IA y prepara propuestas con CernoIA. Conoce los planes y solicita la membresía para tu empresa.";
export function pageMetadata(path: string, title: string, description: string): Metadata {
  const url = SITE_URL + path;
  return { title, description, alternates: { canonical: url },
    openGraph: { title, description, url, siteName: "CernoIA", locale: "es_CO", type: "website" },
    twitter: { card: "summary", title, description },
    robots: { index: true, follow: true, "max-image-preview": "large" } };
}
export function jsonLd(data: unknown) { return JSON.stringify(data).replace(/</g, "\\u003c"); }
