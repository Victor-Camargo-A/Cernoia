export function validateMetadata(input) {
  const fail = (message) => { const error = new Error(message); error.statusCode = 400; throw error; };
  const title = String(input?.title ?? '').trim();
  const description = String(input?.description ?? '').trim();
  if (!title || [...title].length > 100 || /[<>]/.test(title)) fail('El título debe tener entre 1 y 100 caracteres, sin < ni >.');
  if (!description || [...description].length > 5000 || /[<>]/.test(description)) fail('La descripción debe tener entre 1 y 5000 caracteres, sin < ni >.');
  if (!Array.isArray(input.tags) || input.tags.some(t => typeof t !== 'string' || !t.trim() || /[<>]/.test(t))) fail('Las etiquetas no son válidas.');
  const tags = [...new Set(input.tags.map(t => t.trim()))];
  if (tags.map(t => /\s/.test(t) ? `"${t}"` : t).join(',').length > 500) fail('Las etiquetas superan el límite de 500 caracteres.');
  if (!['private','unlisted','public'].includes(input.privacy)) fail('Selecciona la visibilidad.');
  if (!['27','28'].includes(input.categoryId)) fail('Selecciona una categoría válida.');
  if (typeof input.madeForKids !== 'boolean' || typeof input.containsSyntheticMedia !== 'boolean') fail('Confirma la audiencia y el uso de contenido sintético realista.');
  return {title, description, tags, privacy: input.privacy, categoryId: input.categoryId, madeForKids: input.madeForKids, containsSyntheticMedia: input.containsSyntheticMedia, language:'es'};
}
