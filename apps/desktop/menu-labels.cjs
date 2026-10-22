const labels = {
  en: { about: 'About Arch Studio', checkForUpdates: 'Check for updates…' },
  de: { about: 'Über Arch Studio', checkForUpdates: 'Nach Updates suchen…' },
  es: { about: 'Acerca de Arch Studio', checkForUpdates: 'Buscar actualizaciones…' },
  pt: { about: 'Sobre o Arch Studio', checkForUpdates: 'Verificar atualizações…' },
};

function menuLabels(savedLocale, languages) {
  if (Object.hasOwn(labels, savedLocale)) return labels[savedLocale];
  for (const language of languages) {
    const base = language.toLowerCase().split('-')[0];
    if (Object.hasOwn(labels, base)) return labels[base];
  }
  return labels.en;
}

module.exports = { menuLabels };
