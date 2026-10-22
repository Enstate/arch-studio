const labels = {
  en: { about: 'About Arch Studio', checkForUpdates: 'Check for updates…', settings: 'Settings…' },
  de: { about: 'Über Arch Studio', checkForUpdates: 'Nach Updates suchen…', settings: 'Einstellungen…' },
  es: { about: 'Acerca de Arch Studio', checkForUpdates: 'Buscar actualizaciones…', settings: 'Ajustes…' },
  pt: { about: 'Sobre o Arch Studio', checkForUpdates: 'Verificar atualizações…', settings: 'Configurações…' },
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
