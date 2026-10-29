# video-uploader
сервис для загрузки видео

# video-uploader

Мини-сервис для Railway: принимает видео из Telegram Mini App, кладёт в Railway Bucket,
вызывает webhook n8n со ссылкой на файл и удаляет старые файлы.

## Переменные окружения сервиса

| Переменная                                                 | Откуда                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| ENDPOINT, BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION | Variable Reference на бакет Railway                          |
| BOT_TOKEN                                                  | токен бота из BotFather                                      |
| N8N_WEBHOOK_URL                                            | Production URL webhook «video-uploaded»                      |
| N8N_API_KEY                                                | любая длинная случайная строка (такая же UPLOADER_API_KEY в n8n) |
| MAX_MB                                                     | необязательно, по умолчанию 500                              |
| TTL_HOURS                                                  | необязательно, по умолчанию 24                               |
| LINK_HOURS                                                 | необязательно, по умолчанию 6                                |

Запуск: `npm install && npm start`. Health-check: `/health`.

