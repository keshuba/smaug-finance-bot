-- Keep existing installations in step with the public category dictionary.
UPDATE categories
SET keywords_json = json_insert(keywords_json, '$[#]', 'мыло')
WHERE code = 'cosmetics'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(categories.keywords_json) WHERE value = 'мыло'
  );
