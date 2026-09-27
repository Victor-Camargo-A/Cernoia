import { PublicHome } from "@/app/components/public-site";
import { LegacyEntry } from "@/app/components/legacy-entry";
import { pageMetadata, HOME_DESCRIPTION, SITE_URL, jsonLd } from "@/lib/seo";
export const metadata = pageMetadata("/", "CernoIA | Licitaciones SECOP y análisis de requisitos con IA", HOME_DESCRIPTION);
const structuredData = { "@context": "https://schema.org", "@graph": [
  { "@type": "Organization", "@id": SITE_URL + "/#organization", name: "CernoIA", url: SITE_URL, parentOrganization: { "@type": "Organization", name: "Energética Nika S.A.S.", taxID: "902050074-0" }, contactPoint: { "@type": "ContactPoint", telephone: "+57-320-783-0189", contactType: "sales", availableLanguage: "Spanish" } },
  { "@type": "WebSite", "@id": SITE_URL + "/#website", url: SITE_URL, name: "CernoIA", inLanguage: "es-CO", publisher: { "@id": SITE_URL + "/#organization" } },
  { "@type": "SoftwareApplication", name: "CernoIA", url: SITE_URL, applicationCategory: "BusinessApplication", operatingSystem: "Web", description: HOME_DESCRIPTION, featureList: ["Búsqueda de oportunidades de contratación pública", "Análisis de requisitos y documentos", "Preparación de borradores de propuestas", "Seguimiento y alertas"], provider: { "@id": SITE_URL + "/#organization" } }
] };
export default function Home() { return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structuredData) }} /><LegacyEntry /><PublicHome /></>; }
