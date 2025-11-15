const express = require('express')
const cors = require('cors')
const multer = require('multer')
const OpenAI = require('openai')
const path = require('path')
const fs = require('fs')
const { randomUUID } = require('crypto')
const { toFile } = require('openai/uploads')
const { createDb } = require('./db')
const { convertPdfsToJson } = require('./pdfConverter')
try { require('dotenv').config({ path: '.env.local' }) } catch {}
require('dotenv').config()

// Настройка multer для загрузки файлов
const upload = multer({ 
  storage: multer.memoryStorage(),
  // Лимит для PDF файлов (выписки, налоговая и финансовая отчетность)
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB лимит на один файл
})

console.log('Loading Agents SDK...')
const { Agent, Runner, codeInterpreterTool } = require('@openai/agents')
const { z } = require('zod')
console.log('Agents SDK loaded successfully')

const app = express()

app.set('etag', false)

const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 1200000)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

// Настройка CORS для GitHub Pages
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8787',
  'https://mshaim001-hue.github.io',
  'https://*.github.io',
  'https://*.githubpages.io',
  process.env.FRONTEND_URL
].filter(Boolean)

// Логируем разрешенные источники при старте
console.log('🌐 Разрешенные CORS источники:', allowedOrigins)

app.use(cors({
  origin: function (origin, callback) {
    // Разрешаем запросы без origin (например, Postman, curl)
    if (!origin) return callback(null, true)
    
    // Проверяем совпадение с разрешенными источниками
    const isAllowed = allowedOrigins.some(allowed => {
      // Точное совпадение
      if (origin === allowed) return true
      
      // Проверка паттернов с *
      if (allowed.includes('*')) {
        // Заменяем * на .* и экранируем точки
        const pattern = allowed
          .replace(/\*/g, '.*')
          .replace(/\./g, '\\.')
        return new RegExp(`^${pattern}$`).test(origin)
      }
      
      return false
    })
    
    if (isAllowed || allowedOrigins.length === 0) {
      callback(null, true)
    } else {
      console.log(`❌ CORS blocked: ${origin} not in allowed origins:`, allowedOrigins)
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Pragma']
}))
app.use(express.json({ limit: '10mb' }))

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store')
  }
  next()
})

// Health check endpoint для Render.com и других платформ
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  })
})

// Простой ping endpoint
app.get('/ping', (req, res) => {
  res.status(200).send('pong')
})

const frontendDistPath = path.join(__dirname, 'Frontend', 'dist')

// В production отдаем статические файлы после сборки фронтенда
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(frontendDistPath))
}

// Глобальный OpenAI клиент для Assistants API
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: OPENAI_TIMEOUT_MS,
  maxRetries: Number(process.env.OPENAI_MAX_RETRIES || 2),
})

const analysisRunner = new Runner({})

// Инициализация БД (Postgres/SQLite) и создание схемы
const db = createDb()

async function initSchema() {
  if (db.type === 'pg') {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        session_id TEXT UNIQUE NOT NULL,
        company_bin TEXT,
        amount TEXT,
        term TEXT,
        purpose TEXT,
        name TEXT,
        email TEXT,
        phone TEXT,
        comment TEXT,
        openai_response_id TEXT,
        openai_status TEXT,
        report_text TEXT,
        status TEXT DEFAULT 'generating',
        files_count INTEGER DEFAULT 0,
        files_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT DEFAULT 'text',
        message_order INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_size INTEGER,
        mime_type TEXT,
        category TEXT,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
      CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
      
      -- Дополнительные поля для отдельных анализов (налоги и фин. отчетность)
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS tax_report_text TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS tax_status TEXT DEFAULT 'pending';
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS tax_missing_periods TEXT;
      
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS fs_report_text TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS fs_status TEXT DEFAULT 'pending';
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS fs_missing_periods TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS comment TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS openai_response_id TEXT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS openai_status TEXT;
    `)
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        company_bin TEXT,
        amount TEXT,
        term TEXT,
        purpose TEXT,
        name TEXT,
        email TEXT,
        phone TEXT,
        comment TEXT,
        openai_response_id TEXT,
        openai_status TEXT,
        report_text TEXT,
        status TEXT DEFAULT 'generating',
        files_count INTEGER DEFAULT 0,
        files_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT DEFAULT 'text',
        message_order INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_size INTEGER,
        mime_type TEXT,
        category TEXT,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
      CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
    `)
    try {
      db.exec(`ALTER TABLE reports ADD COLUMN comment TEXT`)
    } catch (error) {
      if (!/duplicate column name/i.test(error.message || '')) {
        console.warn('⚠️ Не удалось добавить колонку comment в таблицу reports (SQLite)', error)
      }
    }
    try {
      db.exec(`ALTER TABLE reports ADD COLUMN openai_response_id TEXT`)
    } catch (error) {
      if (!/duplicate column name/i.test(error.message || '')) {
        console.warn('⚠️ Не удалось добавить колонку openai_response_id в таблицу reports (SQLite)', error)
      }
    }
    try {
      db.exec(`ALTER TABLE reports ADD COLUMN openai_status TEXT`)
    } catch (error) {
      if (!/duplicate column name/i.test(error.message || '')) {
        console.warn('⚠️ Не удалось добавить колонку openai_status в таблицу reports (SQLite)', error)
      }
    }
  }
  console.log('✅ Database initialized with all tables')
}

initSchema().catch(e => {
  console.error('❌ DB init failed', e)
})

// SQLite миграции удалены: проект использует только PostgreSQL

// Вспомогательные функции для работы с БД
const saveMessageToDB = async (sessionId, role, content, messageOrder) => {
  try {
    const insertMessage = db.prepare(`
      INSERT INTO messages (session_id, role, content, message_order)
      VALUES (?, ?, ?, ?)
    `)
    await insertMessage.run(sessionId, role, JSON.stringify(content), messageOrder)
    console.log(`💾 Сообщение сохранено в БД: ${role} #${messageOrder}`)
  } catch (error) {
    // Если БД недоступна, логируем но продолжаем работу
    if (error.code === 'XX000' || error.message?.includes('db_termination') || error.message?.includes('shutdown')) {
      console.error(`⚠️ БД соединение разорвано при сохранении сообщения. Продолжаем работу без сохранения.`)
    } else {
      console.error(`❌ Ошибка сохранения сообщения в БД:`, error)
    }
    // Не пробрасываем ошибку - работаем без сохранения в БД
  }
}

const saveFileToDB = async (sessionId, fileId, originalName, fileSize, mimeType, category) => {
  try {
    const insertFile = db.prepare(`
      INSERT INTO files (session_id, file_id, original_name, file_size, mime_type, category)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    await insertFile.run(sessionId, fileId, originalName, fileSize, mimeType, category || null)
    console.log(`📎 Файл сохранен в БД: ${originalName} [${category || 'uncategorized'}]`)
  } catch (error) {
    // Проверяем, это ошибка разрыва соединения с БД
    if (error.code === 'XX000' || error.message?.includes('db_termination') || error.message?.includes('shutdown')) {
      console.error(`❌ БД соединение разорвано при сохранении файла ${originalName}. Переподключаемся...`)
      // Пытаемся переподключиться (БД должна сама переподключиться при следующем запросе)
      throw error // Пробрасываем, чтобы обработчик попытался переподключиться
    }
    console.error(`❌ Ошибка сохранения файла в БД:`, error)
    throw error // Пробрасываем ошибку дальше
  }
}

// Обновление категории уже сохраненного файла (по факту подтверждения от агента)
const updateFileCategoryInDB = async (fileId, category) => {
  try {
    const updateStmt = db.prepare(`
      UPDATE files
      SET category = ?
      WHERE file_id = ?
    `)
    await updateStmt.run(category, fileId)
    console.log(`📎 Категория файла обновлена: ${fileId} -> ${category}`)
  } catch (error) {
    // Если БД недоступна, логируем но не падаем
    if (error.code === 'XX000' || error.message?.includes('db_termination') || error.message?.includes('shutdown')) {
      console.error(`⚠️ БД соединение разорвано при обновлении категории файла. Продолжаем работу.`)
    } else {
      console.error(`❌ Ошибка обновления категории файла:`, error)
    }
    // Не пробрасываем ошибку - это некритично
  }
}

// Определение категории файла по названию/типу
const categorizeUploadedFile = (originalName, mimeType) => {
  const name = String(originalName || '').toLowerCase()
  const type = String(mimeType || '').toLowerCase()
  
  // Финансовая отчетность: Excel файлы, изображения, PDF с финансовыми маркерами, ZIP
  const isExcel = type.includes('excel') || type.includes('spreadsheet') || 
                  name.endsWith('.xlsx') || name.endsWith('.xls')
  const isImage = type.includes('image') || name.match(/\.(jpg|jpeg|png|gif|bmp|webp)$/)
  const isZip = type.includes('zip') || name.endsWith('.zip')
  const isFinancialPdf = type.includes('pdf') && 
                         (name.includes('balance') || name.includes('balans') || name.includes('баланс') ||
                          name.includes('profit') || name.includes('pribyl') || name.includes('прибыль') ||
                          name.includes('loss') || name.includes('ubyitok') || name.includes('убыток') ||
                          name.includes('financial') || name.includes('finance') || name.includes('финанс') ||
                          name.includes('oopu') || name.includes('pnl') || name.includes('опу'))
  
  if (isExcel || isImage || isZip || isFinancialPdf) {
    // Финансовая отчетность: принимаем все форматы (но анализируем только XLSX)
    return 'financial'
  }
  
  // Для налогов и выписок - только PDF
  const isPdf = type.includes('pdf') || name.endsWith('.pdf')
  
  if (isPdf) {
    // Определяем категорию по названию файла
    if (name.includes('nalog') || name.includes('налог') || name.includes('tax')) {
      return 'taxes'
    }
    // По умолчанию считаем PDF как банковские выписки
    return 'statements'
  }
  
  // Если формат не поддерживается - вернем null
  return null
}

const OPENAI_FAILURE_STATUSES = new Set(['failed', 'cancelled', 'expired'])
const FINAL_REPORT_STATUSES = new Set(['completed', 'failed'])

const mapOpenAIStatusToReportStatus = (status) => {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'completed') return 'completed'
  if (OPENAI_FAILURE_STATUSES.has(normalized)) return 'failed'
  return 'generating'
}

const appendAssistantMessage = async (sessionId, text) => {
  if (!text) return
  try {
    conversationHistory.set(sessionId, conversationHistory.get(sessionId) || [])
    const history = conversationHistory.get(sessionId)
    history.push({ role: 'assistant', content: [{ type: 'text', text }] })

    const countRow = await db
      .prepare(`SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?`)
      .get(sessionId)
    const nextOrder = (countRow?.cnt || 0) + 1

    await saveMessageToDB(sessionId, 'assistant', [{ type: 'text', text }], nextOrder)
  } catch (error) {
    console.error('⚠️ Не удалось сохранить сообщение ассистента при синхронизации', {
      sessionId,
      error: error.message,
    })
  }
}

const maybeUpdateReportFromOpenAI = async (reportRow) => {
  const currentStatus = String(reportRow.status || '').toLowerCase()
  if (FINAL_REPORT_STATUSES.has(currentStatus)) return reportRow

  try {
    if (!reportRow?.openai_response_id) {
      return reportRow
    }

    const response = await openaiClient.responses.retrieve(reportRow.openai_response_id, {
      timeout: Math.min(OPENAI_TIMEOUT_MS, 15000),
    })

    const openaiStatus = response.status
    const reportStatus = mapOpenAIStatusToReportStatus(openaiStatus)

    let reportText = reportRow.report_text || null
    let completionTimestamp = reportRow.completed_at || null

    if (reportStatus === 'completed') {
      const outputText = extractOutputText(response)
      if (outputText && !reportRow.report_text) {
        await appendAssistantMessage(reportRow.session_id, outputText)
        reportText = outputText
      } else if (outputText) {
        reportText = outputText
      }
      completionTimestamp = new Date().toISOString()
    } else if (reportStatus === 'failed') {
      if (!reportText) {
        reportText = response.last_error?.message || `OpenAI вернул статус ${openaiStatus}`
      }
      completionTimestamp = new Date().toISOString()
    }

    await upsertReport(reportRow.session_id, {
      status: reportStatus,
      reportText,
      filesCount: reportRow.files_count,
      filesData: reportRow.files_data,
      completed: completionTimestamp,
      comment: reportRow.comment,
      openaiResponseId: response.id,
      openaiStatus,
    })

    const updatedRow = await db
      .prepare(
        `SELECT session_id, status, company_bin, amount, term, purpose, name, email, phone, comment, created_at, completed_at, files_count, files_data, report_text, tax_report_text, tax_status, tax_missing_periods, fs_report_text, fs_status, fs_missing_periods, openai_response_id, openai_status
         FROM reports
         WHERE session_id = ?`
      )
      .get(reportRow.session_id)

    return updatedRow || reportRow
  } catch (error) {
    console.error('⚠️ Не удалось обновить статус отчёта из OpenAI', {
      sessionId: reportRow.session_id,
      error: error.message,
    })
    return reportRow
  }
}

// Получение прогресса по сессии
const getSessionProgress = async (sessionId) => {
  const rows = await db.prepare(`SELECT category, COUNT(*) as cnt FROM files WHERE session_id = ? GROUP BY category`).all(sessionId)
  const safeRows = Array.isArray(rows) ? rows : []
  if (!Array.isArray(rows)) {
    console.warn('getSessionProgress: unexpected rows', rows)
  }
  const map = Object.fromEntries(safeRows.map(r => [r.category || 'uncategorized', r.cnt]))
  return {
    statements: (map['statements'] || 0) > 0,
    taxes: (map['taxes'] || 0) > 0,
    financial: (map['financial'] || 0) > 0
  }
}

const getMessagesFromDB = async (sessionId) => {
  try {
    const getMessages = db.prepare(`
      SELECT role, content, message_order
      FROM messages 
      WHERE session_id = ? 
      ORDER BY message_order ASC
    `)
    const messages = await getMessages.all(sessionId)
    const safeMessages = Array.isArray(messages) ? messages : []
    if (!Array.isArray(messages)) {
      console.warn('getMessagesFromDB: unexpected messages', messages)
    }
    return safeMessages.map(msg => ({
      role: msg.role,
      content: JSON.parse(msg.content)
    }))
  } catch (error) {
    console.error(`❌ Ошибка получения сообщений из БД:`, error)
    return []
  }
}

// Хранилище для истории диалогов (в памяти) - теперь дублируется в БД
const conversationHistory = new Map()

// Хранилище для файлов по сессиям
// Формат: session -> [{fileId: string, originalName: string, size: number}]
const sessionFiles = new Map()

// Гварды, чтобы не запускать повторно анализы для одной и той же сессии
const runningStatementsSessions = new Set()
const runningTaxSessions = new Set()
const runningFsSessions = new Set()

// Code Interpreter без предустановленных файлов
// Файлы будут добавляться динамически
const codeInterpreter = codeInterpreterTool({
  container: { type: 'auto' }
})

const InvestmentAgentSchema = z.object({
  amount: z.number().nullable().optional(),
  term_months: z.number().nullable().optional(),
  completed: z.boolean().nullable().optional()
})

// Financial Analyst Agent для создания отчета
// УПРОЩЕННЫЕ ИНСТРУКЦИИ: теперь агент получает уже очищенные JSON данные с операциями по кредиту
const financialAnalystInstructions = `Ты финансовый аналитик iKapitalist. Твоя ГЛАВНАЯ ЦЕЛЬ - определить чистую выручку от реализации товаров и услуг на основе уже очищенных данных банковских выписок.

📊 **РЕЗЮМЕ ЗАЯВКИ**
- Компания: [БИН], название компании: [Название компании], период: [Период]

🎯 **ОСНОВНЫЕ НАПРАВЛЕНИЯ РАБОТЫ**

ВАЖНО: Ты получаешь уже очищенные JSON данные из банковских выписок. Все операции уже отфильтрованы - остались только операции по КРЕДИТУ (поступления на счет).

1. 💰 **АНАЛИЗ ОПЕРАЦИЙ ПО НАЗНАЧЕНИЮ ПЛАТЕЖА**
   Цель: Определить, какие операции являются выручкой от реализации товаров и услуг.
   
   Что нужно сделать:
   - Проанализируй каждую операцию в JSON данных
   - По полю "Назначение платежа" определи, является ли операция оплатой от клиентов за товары или услуги
   - Включи в выручку только операции, которые явно связаны с продажей товаров/услуг
   
   Примеры операций, которые ЯВЛЯЮТСЯ выручкой:
   - "Оплата за товары", "Оплата за услуги", "Оплата по договору поставки"
   - "Оплата счета", "Оплата за выполненные работы"
   - Любые операции, где в назначении платежа упоминается продажа товаров/услуг
   
   Примеры операций, которые НЕ ЯВЛЯЮТСЯ выручкой:
   - "Возврат займа", "Погашение кредита", "Возврат средств"
   - "Перевод между счетами", "Пополнение счета"
   - "Ошибочное зачисление", "Возврат товара"
   - Любые внутренние переводы или финансовые операции

2. 💱 **УЧЁТ ВАЛЮТНЫХ СЧЕТОВ**
   Цель: Корректно включить валютную выручку в общую сумму.
   
   Что нужно сделать:
   - Если в данных есть поле "Курс" или информация о валюте - используй его для конвертации
   - Конвертируй валютные суммы в тенге по курсу на дату операции
   - Если курс не указан, используй средний курс за период или укажи это в отчете

3. 📅 **ГРУППИРОВКА ПО МЕСЯЦАМ**
   Цель: Посмотреть динамику продаж во времени.
   
   Что нужно сделать:
   - Используй поле "Дата" из JSON данных для группировки
   - Сгруппируй операции по месяцам и годам
   - Рассчитай сумму выручки за каждый месяц
   - Убедись, что покрыт весь период из выписок

4. 📈 **ФОРМИРОВАНИЕ СВОДНОГО АНАЛИЗА**
   Цель: Подготовить понятный итог для отчёта.
   
   Что нужно сделать:
   - Сделай сводную таблицу с колонками:
     * Месяц
     * Количество операций
     * Чистая выручка (KZT)
   - Подсчитай общую сумму выручки за весь период

5. ⚖️ **СРАВНЕНИЕ С ТРЕБОВАНИЯМИ ПЛАТФОРМЫ**
   Цель: Проверить соответствие лимиту.
   
   Что нужно сделать:
   - Сравни общую чистую выручку за 12 месяцев с порогом 60 млн тенге
   - Если меньше — компания НЕ соответствует требованиям платформы
   - Если больше или равна — компания соответствует требованиям

📋 **СТРУКТУРА ОТЧЕТА**

**АНАЛИЗ ПО БАНКАМ:**
Для каждого банка (если в JSON есть информация о банке):
- БИН компании (из метаданных)
- Название компании (из метаданных)
- Название банка и период(ы) выписки
- Количество операций по кредиту
- Количество операций, признанных выручкой
- Чистая выручка по банку (KZT)
- Исключённые операции (с обоснованием, почему не выручка)

**СВОДНЫЙ АНАЛИЗ:**
- Общая чистая выручка за период: [сумма] KZT
- Динамика по месяцам (таблица)
- Соответствие требованиям платформы: ✅/❌

**РЕКОМЕНДАЦИЯ:**
- ✅ СООТВЕТСТВУЕТ требованиям (выручка ≥ 60 млн KZT)
- ❌ НЕ СООТВЕТСТВУЕТ требованиям (выручка < 60 млн KZT)

---

ВАЖНО:
- Ты получаешь JSON данные, которые уже содержат только операции по кредиту
- Все операции имеют поля: Дата, Кредит, Назначение платежа, и другие
- Твоя задача - проанализировать "Назначение платежа" и определить, является ли операция выручкой
- Используй Code Interpreter для анализа JSON данных
- Все суммы указывай в KZT с разделителями тысяч
- Будь точным с датами и периодами
- Выдели ключевые моменты жирным шрифтом
- Используй эмодзи для визуальной структуры`

const defaultUserPrompt = `${financialAnalystInstructions}

Проанализируй прикреплённые JSON данные с операциями по кредиту из банковских выписок и подготовь отчёт строго по указанной выше инструкции.`

const createFinancialAnalystAgent = (fileIds = []) => {
  const toolConfig = {
    container: { type: 'auto' },
  }

  if (Array.isArray(fileIds) && fileIds.length > 0) {
    toolConfig.container.file_ids = fileIds
  }

  return new Agent({
    name: 'Financial Analyst',
    instructions: financialAnalystInstructions,
    model: 'gpt-5',
    modelSettings: { store: true },
    tools: [codeInterpreterTool(toolConfig)],
  })
}

const normalizeMetadata = (raw) => {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch (error) {
    console.warn('⚠️ Не удалось распарсить metadata, оставляем как строку', raw, error)
    return { raw }
  }
}

const extractOutputText = (response) => {
  if (!response) return ''
  if (typeof response.output_text === 'string') return response.output_text
  if (Array.isArray(response.output_text)) {
    return response.output_text.join('\n')
  }

  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (Array.isArray(item.content)) {
        for (const chunk of item.content) {
          if (chunk.type === 'output_text' && typeof chunk.text === 'string') {
            return chunk.text
          }
          if (chunk.type === 'text' && typeof chunk.text === 'string') {
            return chunk.text
          }
        }
      }
    }
  }

  if (response?.data?.[0]?.content?.[0]?.text) {
    return response.data[0].content[0].text
  }

  return ''
}

const upsertReport = async (sessionId, payload) => {
  const { status, reportText, filesCount, filesData, completed, comment, openaiResponseId, openaiStatus } = payload
  try {
    const stmt = db.prepare(`
      INSERT INTO reports (session_id, status, report_text, files_count, files_data, completed_at, comment, openai_response_id, openai_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        status = excluded.status,
        report_text = excluded.report_text,
        files_count = excluded.files_count,
        files_data = excluded.files_data,
        completed_at = excluded.completed_at,
        comment = COALESCE(excluded.comment, reports.comment),
        openai_response_id = COALESCE(excluded.openai_response_id, reports.openai_response_id),
        openai_status = COALESCE(excluded.openai_status, reports.openai_status)
    `)
    await stmt.run(
      sessionId,
      status,
      reportText || null,
      typeof filesCount === 'number' ? filesCount : null,
      filesData || null,
      completed || null,
      comment ?? null,
      openaiResponseId ?? null,
      openaiStatus ?? null
    )
  } catch (error) {
    console.error('❌ Ошибка сохранения отчёта в БД:', error)
  }
}

const summariseFilesForLog = (files = []) =>
  files.map((file) => ({
    name: file.originalname,
    size: file.size,
    mime: file.mimetype,
  }))

const buildPromptFromMetadata = (metadata) => {
  if (!metadata || typeof metadata !== 'object') return ''
  const entries = Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)

  if (entries.length === 0) {
    return ''
  }

  return `Дополнительные данные от сотрудника:\n${entries.join('\n')}`
}

app.post('/api/analysis', upload.array('files'), async (req, res) => {
  const startedAt = new Date()
  const incomingSession = req.body?.sessionId
  const sessionId = incomingSession || randomUUID()
  const comment = (req.body?.comment || '').toString().trim()
  const metadata = normalizeMetadata(req.body?.metadata)
  const files = req.files || []

  console.log('🛰️ Получен запрос /api/analysis', {
    sessionId,
    commentLength: comment.length,
    files: summariseFilesForLog(files),
    metadata,
  })

  if (!files.length) {
    console.error('❌ Запрос без файлов, возвращаем 400')
    return res.status(400).json({
      ok: false,
      code: 'FILES_REQUIRED',
      message: 'Необходимо прикрепить хотя бы один файл для анализа.',
    })
  }

  try {
    conversationHistory.set(sessionId, conversationHistory.get(sessionId) || [])
    const history = conversationHistory.get(sessionId)

    if (comment) {
      history.push({ role: 'user', content: [{ type: 'text', text: comment }] })
      await saveMessageToDB(sessionId, 'user', [{ type: 'text', text: comment }], history.length)
    }

    const attachments = []
    const pdfFiles = []
    const otherFiles = []

    // Разделяем файлы на PDF и остальные
    for (const file of files) {
      const isPdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')
      if (isPdf) {
        pdfFiles.push(file)
      } else {
        otherFiles.push(file)
      }
    }

    // Обрабатываем PDF файлы: конвертируем в JSON
    if (pdfFiles.length > 0) {
      console.log(`🔄 Конвертирую ${pdfFiles.length} PDF файл(ов) в JSON...`)
      try {
        const pdfDataForConversion = pdfFiles.map(file => ({
          buffer: file.buffer,
          filename: file.originalname
        }))
        
        const jsonResults = await convertPdfsToJson(pdfDataForConversion)
        console.log(`✅ Конвертация завершена: получено ${jsonResults.length} результат(ов)`)

        // Объединяем все транзакции из всех файлов
        const allTransactions = []
        const allMetadata = []
        
        for (const result of jsonResults) {
          if (result.error) {
            console.warn(`⚠️ Ошибка при конвертации файла ${result.source_file}: ${result.error}`)
            continue
          }
          
          if (result.transactions && Array.isArray(result.transactions)) {
            allTransactions.push(...result.transactions)
          }
          
          if (result.metadata) {
            allMetadata.push({
              source_file: result.source_file,
              ...result.metadata
            })
          }
        }

        // Создаем JSON файл с результатами конвертации (даже если транзакций нет)
        const jsonData = {
          metadata: allMetadata,
          transactions: allTransactions,
          summary: {
            total_files: pdfFiles.length,
            total_transactions: allTransactions.length,
            converted_at: new Date().toISOString()
          }
        }

        const jsonString = JSON.stringify(jsonData, null, 2)
        const jsonBuffer = Buffer.from(jsonString, 'utf-8')
        const jsonFilename = `converted_statements_${Date.now()}.json`

        if (allTransactions.length > 0) {
          console.log(`📄 Создан JSON файл: ${jsonFilename} (${jsonBuffer.length} bytes, ${allTransactions.length} транзакций)`)
        } else {
          console.warn(`⚠️ Создан JSON файл без транзакций: ${jsonFilename} (возможно, в PDF нет операций по кредиту)`)
        }

        // ВАЖНО: OpenAI Code Interpreter не поддерживает JSON файлы напрямую
        // Включаем JSON данные в промпт вместо загрузки файла
        // Это более надежный способ передачи данных агенту
        
        // Сохраняем JSON данные для включения в промпт
        const jsonDataString = JSON.stringify(jsonData, null, 2)
        
        // Сохраняем информацию о конвертированных данных для использования в промпте
        attachments.push({
          is_converted: true,
          source_files: pdfFiles.map(f => f.originalname),
          json_data: jsonDataString,
          transaction_count: allTransactions.length
        })
      } catch (conversionError) {
        console.error('❌ Ошибка конвертации PDF в JSON:', conversionError.message)
        // Продолжаем работу, но без конвертированных данных
        // Можно также пробросить ошибку, если нужно
        throw new Error(`Не удалось конвертировать PDF файлы: ${conversionError.message}`)
      }
    }

    // Обрабатываем остальные файлы (не PDF) - загружаем как обычно
    for (const file of otherFiles) {
      console.log(
        `📤 Отправляем файл в OpenAI Files API: ${file.originalname} (${file.mimetype}, ${file.size} bytes)`
      )

      const uploadedFile = await openaiClient.files.create({
        file: await toFile(file.buffer, file.originalname, { type: file.mimetype }),
        purpose: 'assistants',
      })

      console.log('✅ Файл загружен в OpenAI', {
        fileId: uploadedFile.id,
        filename: uploadedFile.filename,
        purpose: uploadedFile.purpose,
      })

      const category = categorizeUploadedFile(file.originalname, file.mimetype)
      try {
        await saveFileToDB(
          sessionId,
          uploadedFile.id,
          file.originalname,
          file.size,
          file.mimetype,
          category
        )
      } catch (error) {
        console.error('⚠️ Не удалось сохранить файл в БД, продолжаем работу', error)
      }

      attachments.push({
        file_id: uploadedFile.id,
        original_filename: file.originalname,
      })
    }

    const filesDataJson = JSON.stringify(
      files.map((file) => ({
        name: file.originalname,
        size: file.size,
        mime: file.mimetype,
      }))
    )

    try {
      await upsertReport(sessionId, {
        status: 'generating',
        reportText: null,
        filesCount: files.length,
        filesData: filesDataJson,
        completed: null,
        comment,
      })
    } catch (error) {
      console.error('⚠️ Не удалось создать запись отчёта перед анализом', error)
    }

    const metadataPrompt = buildPromptFromMetadata(metadata)
    
    // Формируем промпт с учетом того, что PDF уже конвертированы в JSON
    let jsonDataInPrompt = ''
    const jsonAttachments = attachments.filter(a => a.is_converted && a.json_data)
    
    if (jsonAttachments.length > 0) {
      // Включаем JSON данные прямо в промпт, так как Code Interpreter не поддерживает JSON файлы
      const allJsonData = jsonAttachments.map(att => att.json_data).join('\n\n--- Следующий файл ---\n\n')
      jsonDataInPrompt = `\n\n📊 **ДАННЫЕ ИЗ БАНКОВСКИХ ВЫПИСОК (JSON):**\n\nВсе операции уже отфильтрованы - остались только операции по КРЕДИТУ (поступления на счет). Проанализируй каждую операцию по полю "Назначение платежа" и определи, является ли она выручкой от реализации товаров и услуг.\n\n\`\`\`json\n${allJsonData}\n\`\`\``
    }
    
    const combinedPrompt = [defaultUserPrompt, jsonDataInPrompt, metadataPrompt, comment]
      .filter(Boolean)
      .join('\n\n')

    // Фильтруем только реальные файлы (не конвертированные JSON, которые уже в промпте)
    const realFileAttachments = attachments.filter(a => !a.is_converted || !a.json_data)
    const fileIds = realFileAttachments.map((attachment) => attachment.file_id).filter(Boolean)
    const analystAgent = createFinancialAnalystAgent(fileIds)

    // Формируем входные данные для агента
    const agentInput = []
    
    // Основной промпт с JSON данными
    agentInput.push({
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: combinedPrompt,
        },
      ],
    })
    
    // Добавляем реальные файлы (не PDF, которые уже конвертированы)
    for (const attachment of realFileAttachments) {
      if (attachment.file_id) {
        agentInput.push({
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Дополнительный файл: ${attachment.original_filename || attachment.file_id}`,
            },
            {
              type: 'input_file',
              file: { id: attachment.file_id },
            },
          ],
        })
      }
    }

    console.log('🤖 Запускаем финансового аналитика через Runner (async)', {
      fileIds: fileIds.length,
      promptPreview: combinedPrompt.slice(0, 200),
    })

    ;(async () => {
      try {
        const runResult = await analysisRunner.run(analystAgent, agentInput)

        const rawNewItems = Array.isArray(runResult.newItems)
          ? runResult.newItems.map((item) => item?.rawItem || item)
          : []

        const historyLengthBefore = history.length
        if (rawNewItems.length > 0) {
          history.push(...rawNewItems)
        }

        for (let index = 0; index < rawNewItems.length; index += 1) {
          const item = rawNewItems[index]
          const role = item?.role
          if (role === 'assistant' || role === 'user') {
            try {
              await saveMessageToDB(sessionId, role, item.content, historyLengthBefore + index + 1)
            } catch (dbError) {
              if (
                dbError.code === 'XX000' ||
                dbError.message?.includes('db_termination') ||
                dbError.message?.includes('shutdown')
              ) {
                console.error(
                  '⚠️ БД соединение разорвано при сохранении сообщения агента. Продолжаем работу без сохранения в БД.'
                )
              } else {
                console.error(
                  '⚠️ Ошибка сохранения сообщения агента в БД (продолжаем работу):',
                  dbError.message
                )
              }
            }
          }
        }

        let finalOutputText = ''
        if (typeof runResult.finalOutput === 'string') {
          finalOutputText = runResult.finalOutput.trim()
        } else if (
          runResult.finalOutput &&
          typeof runResult.finalOutput === 'object' &&
          typeof runResult.finalOutput.text === 'string'
        ) {
          finalOutputText = runResult.finalOutput.text.trim()
        }

        if (!finalOutputText) {
          finalOutputText =
            extractAssistantAnswer(rawNewItems) ||
            extractAssistantAnswer(Array.isArray(runResult.history) ? runResult.history : []) ||
            ''
        }

        const completedAt = new Date().toISOString()

        await upsertReport(sessionId, {
          status: finalOutputText ? 'completed' : 'failed',
          reportText: finalOutputText || 'Не удалось получить текст отчёта от агента.',
          filesCount: files.length,
          filesData: filesDataJson,
          completed: completedAt,
          comment,
          openaiResponseId: runResult.lastResponseId || null,
          openaiStatus: finalOutputText ? 'completed' : 'failed',
        })

        console.log('📦 Анализ завершён (async)', {
          sessionId,
          durationMs: Date.now() - startedAt.getTime(),
          responseId: runResult.lastResponseId,
        })
      } catch (streamError) {
        console.error('❌ Ошибка в фоне при обработке анализа', {
          sessionId,
          error: streamError.message,
        })
        try {
          await upsertReport(sessionId, {
            status: 'failed',
            reportText: streamError.message,
            filesCount: files.length,
            filesData: filesDataJson,
            completed: new Date().toISOString(),
            comment,
            openaiResponseId: null,
            openaiStatus: 'failed',
          })
        } catch (dbError) {
          console.error('⚠️ Не удалось зафиксировать ошибку в БД (async)', dbError)
        }
      }
    })().catch((unhandled) => {
      console.error('❌ Необработанная ошибка фонового анализа', {
        sessionId,
        error: unhandled?.message || unhandled,
      })
    })

    const progress = await getSessionProgress(sessionId)

    return res.status(202).json({
      ok: true,
      sessionId,
      status: 'generating',
      openaiStatus: 'generating',
      message: 'Анализ запущен. Обновите историю позже, чтобы увидеть результат.',
      data: {
        progress,
      },
      completed: false,
    })
  } catch (error) {
    console.error('❌ Ошибка анализа выписок', {
      sessionId,
      error: error.message,
      stack: error.stack,
    })

    try {
      await upsertReport(sessionId, {
        status: 'failed',
        reportText: error.message,
        filesCount: files.length,
        filesData: JSON.stringify(summariseFilesForLog(files)),
        completed: new Date().toISOString(),
        comment,
        openaiStatus: 'failed',
      })
    } catch (dbError) {
      console.error('⚠️ Не удалось зафиксировать ошибку в БД', dbError)
    }

    return res.status(500).json({
      ok: false,
      code: 'ANALYSIS_FAILED',
      message: 'Не удалось завершить анализ выписок. Проверьте логи на сервере.',
      error: error.message,
    })
  }
})

app.get('/api/reports', async (_req, res) => {
  try {
    const rows = await db
      .prepare(
        `SELECT session_id, status, company_bin, amount, term, purpose, name, email, phone, comment, created_at, completed_at, files_count, files_data, report_text, openai_response_id, openai_status 
         FROM reports 
         ORDER BY created_at DESC 
         LIMIT 100`
      )
      .all()

    const list = Array.isArray(rows) ? rows : []
    const refreshed = await Promise.all(list.map((row) => maybeUpdateReportFromOpenAI(row)))
    res.json(refreshed)
  } catch (error) {
    console.error('❌ Ошибка получения списка отчётов', error)
    res.status(500).json({ ok: false, message: 'Не удалось получить отчёты.' })
  }
})

app.get('/api/reports/:sessionId', async (req, res) => {
  const { sessionId } = req.params
  try {
    const row = await db
      .prepare(
        `SELECT session_id, status, company_bin, amount, term, purpose, name, email, phone, comment, created_at, completed_at, files_count, files_data, report_text, tax_report_text, tax_status, tax_missing_periods, fs_report_text, fs_status, fs_missing_periods, openai_response_id, openai_status
         FROM reports 
         WHERE session_id = ?`
      )
      .get(sessionId)

    if (!row) {
      return res.status(404).json({ ok: false, message: 'Отчёт не найден.' })
    }

    const syncedRow = await maybeUpdateReportFromOpenAI(row)
    res.json(syncedRow || row)
  } catch (error) {
    console.error('❌ Ошибка получения отчёта', error)
    res.status(500).json({ ok: false, message: 'Не удалось получить отчёт.' })
  }
})

app.get('/api/reports/:sessionId/messages', async (req, res) => {
  const { sessionId } = req.params
  try {
    const messages = await getMessagesFromDB(sessionId)
    res.json(messages)
  } catch (error) {
    console.error('❌ Ошибка получения сообщений', error)
    res.status(500).json({ ok: false, message: 'Не удалось получить сообщения.' })
  }
})

app.delete('/api/reports/:sessionId', async (req, res) => {
  const { sessionId } = req.params

  if (!sessionId) {
    return res.status(400).json({ ok: false, message: 'Не указан идентификатор сессии.' })
  }

  try {
    const existing = await db
      .prepare(`SELECT session_id FROM reports WHERE session_id = ?`)
      .get(sessionId)

    if (!existing) {
      return res.status(404).json({ ok: false, message: 'Отчёт не найден.' })
    }

    await db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId)
    await db.prepare(`DELETE FROM files WHERE session_id = ?`).run(sessionId)
    await db.prepare(`DELETE FROM reports WHERE session_id = ?`).run(sessionId)

    conversationHistory.delete(sessionId)
    sessionFiles.delete(sessionId)
    runningStatementsSessions.delete(sessionId)
    runningTaxSessions.delete(sessionId)
    runningFsSessions.delete(sessionId)

    return res.status(204).send()
  } catch (error) {
    console.error('❌ Ошибка удаления отчёта', error)
    return res.status(500).json({ ok: false, message: 'Не удалось удалить отчёт.' })
  }
})

let agentsModulePromise = null
let qaAgentInstance = null

const loadAgentsModule = async () => {
  if (!agentsModulePromise) {
    agentsModulePromise = import('@openai/agents')
  }
  return agentsModulePromise
}

const getQaAgent = async () => {
  const { Agent } = await loadAgentsModule()
  if (!qaAgentInstance) {
    qaAgentInstance = new Agent({
      name: 'iKapitalist Assistant',
      model: 'gpt-5-mini',
      modelSettings: { store: true },
      instructions: `
        Ты виртуальный аналитик iKapitalist. Отвечай на вопросы пользователей про процесс анализа выписок,
        загрузку документов, статусы отчётов и работу платформы. Отвечай кратко и по делу, на русском языке.
        Если тебя просят сделать что-то, что доступно только в интерфейсе (например, загрузить файлы или удалить отчёт),
        объясни пользователю, как это сделать в приложении. Если не знаешь ответ, честно признайся и предложи проверить
        актуальную информацию в интерфейсе или обратиться в поддержку iKapitalist.
      `.trim(),
    })
  }
  return qaAgentInstance
}

const contentItemToString = (item) => {
  if (!item) return ''
  if (typeof item === 'string') return item
  if (typeof item.text === 'string') return item.text
  if (item.text && typeof item.text.value === 'string') return item.text.value
  if (item.type === 'output_text' && typeof item.value === 'string') return item.value
  if (item.type === 'input_text' && typeof item.text === 'string') return item.text
  return ''
}

const extractAssistantAnswer = (items) => {
  if (!Array.isArray(items)) return ''
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const entry = items[index]
    const payload = entry?.rawItem || entry
    if (!payload || typeof payload !== 'object') continue
    const role = payload.role
    if (role !== 'assistant') continue
    const content = payload.content
    if (typeof content === 'string') {
      const trimmed = content.trim()
      if (trimmed) return trimmed
      continue
    }
    if (Array.isArray(content)) {
      for (const contentItem of content) {
        const text = contentItemToString(contentItem).trim()
        if (text) return text
      }
    }
  }
  return ''
}

const runQaAgent = async (prompt, options = {}) => {
  const { run } = await loadAgentsModule()
  const agent = await getQaAgent()
  const result = await run(agent, prompt, options)
  let answer = result?.finalOutput

  if (answer && typeof answer === 'object') {
    try {
      const serialized = JSON.stringify(answer)
      if (serialized && serialized !== '{}') {
        answer = serialized
      } else {
        answer = null
      }
    } catch {
      answer = null
    }
  }

  if (typeof answer === 'string') {
    answer = answer.trim()
  }

  if (!answer) {
    const fallback =
      extractAssistantAnswer(Array.isArray(result?.newItems) ? result.newItems : []) ||
      extractAssistantAnswer(Array.isArray(result?.history) ? result.history : [])
    answer = fallback
  }

  return { result, answer }
}

app.post('/api/agent/query', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(503).json({ ok: false, message: 'OpenAI API ключ не настроен на сервере.' })
  }

  const { question, options } = req.body || {}
  const prompt = typeof question === 'string' ? question.trim() : ''

  if (!prompt) {
    return res.status(400).json({ ok: false, message: 'Введите вопрос для агента.' })
  }

  try {
    const { result, answer } = await runQaAgent(prompt, options)
    return res.json({
      ok: true,
      answer: answer ?? '',
      finalAgent: result.finalAgent ? result.finalAgent.name || result.finalAgent : qaAgentInstance?.name,
      history: result.history ?? [],
    })
  } catch (error) {
    console.error('❌ Ошибка обращения к агенту', {
      prompt,
      error: error?.message || error,
    })
    const message =
      error?.status === 401
        ? 'Недостаточно прав для выполнения запроса к OpenAI. Проверьте ключ.'
        : error?.message || 'Не удалось получить ответ от агента.'
    return res.status(500).json({ ok: false, message })
  }
})

if (process.env.NODE_ENV === 'production') {
  app.get(/^\/(?!api\/).*$/, (_req, res) => {
    res.sendFile(path.join(frontendDistPath, 'index.html'))
  })
}

const port = process.env.PORT || 3001

// Запускаем сервер сразу, не дожидаясь инициализации БД
// Это важно для Render.com, чтобы health check работал быстро
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Backend iKapitalist запущен на порту ${port}`)
  console.log(`📡 Health check доступен на http://0.0.0.0:${port}/health`)
  console.log(`🏥 Ping endpoint доступен на http://0.0.0.0:${port}/ping`)
})

// Обработка graceful shutdown для Render.com и других платформ
const gracefulShutdown = (signal) => {
  console.log(`\n📛 Получен сигнал ${signal}, начинаем graceful shutdown...`)
  
  server.close((err) => {
    if (err) {
      console.error('❌ Ошибка при закрытии сервера:', err)
      process.exit(1)
    }
    
    console.log('✅ HTTP сервер закрыт')
    
    // Закрываем соединение с БД, если есть метод close
    if (db && typeof db.close === 'function') {
      try {
        db.close()
        console.log('✅ Соединение с БД закрыто')
      } catch (dbError) {
        console.error('⚠️ Ошибка при закрытии БД:', dbError)
      }
    }
    
    console.log('✅ Graceful shutdown завершен')
    process.exit(0)
  })
  
  // Таймаут для принудительного завершения
  setTimeout(() => {
    console.error('⚠️ Принудительное завершение после таймаута')
    process.exit(1)
  }, 10000) // 10 секунд
}

// Обработка сигналов завершения
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// Обработка необработанных ошибок
process.on('uncaughtException', (error) => {
  console.error('❌ Необработанное исключение:', error)
  gracefulShutdown('uncaughtException')
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Необработанный rejection:', reason)
  console.error('Promise:', promise)
  // Не завершаем процесс для unhandledRejection, только логируем
})

