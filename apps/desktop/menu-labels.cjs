const labels = {
  en: { about: 'About Arch Studio', checkForUpdates: 'Check for updates…', settings: 'Settings…', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all', addToDictionary: 'Add to dictionary', noSuggestions: 'No suggestions', pageCrashed: 'Arch Studio stopped again', pageCrashedDetail: 'The page ran out of memory twice in a minute. Your projects are saved. Open Studio again?', reopen: 'Open again', quit: 'Quit' },
  de: { about: 'Über Arch Studio', checkForUpdates: 'Nach Updates suchen…', settings: 'Einstellungen…', cut: 'Ausschneiden', copy: 'Kopieren', paste: 'Einsetzen', selectAll: 'Alles auswählen', addToDictionary: 'Zum Wörterbuch hinzufügen', noSuggestions: 'Keine Vorschläge', pageCrashed: 'Arch Studio wurde erneut beendet', pageCrashedDetail: 'Der Seite ging zweimal in einer Minute der Speicher aus. Deine Projekte sind gespeichert. Studio wieder öffnen?', reopen: 'Wieder öffnen', quit: 'Beenden' },
  es: { about: 'Acerca de Arch Studio', checkForUpdates: 'Buscar actualizaciones…', settings: 'Ajustes…', cut: 'Cortar', copy: 'Copiar', paste: 'Pegar', selectAll: 'Seleccionar todo', addToDictionary: 'Agregar al diccionario', noSuggestions: 'Sin sugerencias', pageCrashed: 'Arch Studio se detuvo otra vez', pageCrashedDetail: 'La página se quedó sin memoria dos veces en un minuto. Tus proyectos están guardados. ¿Abrir Studio de nuevo?', reopen: 'Abrir de nuevo', quit: 'Salir' },
  pt: { about: 'Sobre o Arch Studio', checkForUpdates: 'Verificar atualizações…', settings: 'Configurações…', cut: 'Recortar', copy: 'Copiar', paste: 'Colar', selectAll: 'Selecionar tudo', addToDictionary: 'Adicionar ao dicionário', noSuggestions: 'Nenhuma sugestão', pageCrashed: 'O Arch Studio parou de novo', pageCrashedDetail: 'A página ficou sem memória duas vezes em um minuto. Seus projetos estão salvos. Abrir o Studio de novo?', reopen: 'Abrir de novo', quit: 'Sair' },
};

/** Studio's saved language, else the first supported system language, else English. */
function menuLocale(savedLocale, languages) {
  if (Object.hasOwn(labels, savedLocale)) return savedLocale;
  for (const language of languages) {
    const base = language.toLowerCase().split('-')[0];
    if (Object.hasOwn(labels, base)) return base;
  }
  return 'en';
}
const menuLabels = locale => labels[locale];

module.exports = { menuLabels, menuLocale };
