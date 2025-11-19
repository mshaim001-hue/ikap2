// Минимальная загрузка для быстрого запуска
const express = require('express')
const app = express()

app.set('etag', false)

// Health check endpoints должны быть САМЫМИ ПЕРВЫМИ
// Это критично для Render.com - они должны отвечать ДО загрузки всех модулей
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  })
})

app.get('/ping', (req, res) => {
  res.status(200).send('pong')
})

// Теперь загружаем остальные модули после регистрации health check
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

// Agents SDK будет загружен асинхронно после запуска сервера
// Это ускоряет запуск и позволяет health check отвечать сразу
let Agent, Runner, z
let agentsSDKLoaded = false

const loadAgentsSDK = async () => {
  if (agentsSDKLoaded) return
  try {
    console.log('⏳ Загрузка Agents SDK...')
    const agentsModule = require('@openai/agents')
    Agent = agentsModule.Agent
    Runner = agentsModule.Runner
    z = require('zod')
    agentsSDKLoaded = true
    console.log('✅ Agents SDK загружен успешно')
  } catch (error) {
    console.error('❌ Ошибка загрузки Agents SDK:', error)
    throw error
  }
}

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

let analysisRunner = null

// Инициализация БД (Postgres/SQLite) и создание схемы
// Делаем инициализацию ленивой, чтобы сервер мог запуститься даже если БД недоступна
let db = null
let dbInitialized = false

const getDb = () => {
  if (!db && !dbInitialized) {
    try {
      db = createDb()
      dbInitialized = true
      console.log('✅ Database connection pool created')
    } catch (error) {
      console.error('⚠️ Database initialization failed:', error.message)
      dbInitialized = true
      // Пробрасываем ошибку, чтобы вызывающий код мог обработать её
      throw error
    }
  }
  if (!db) {
    const errorMsg = 'Database not initialized. Please check DATABASE_URL environment variable.'
    console.error('❌', errorMsg)
    throw new Error(errorMsg)
  }
  return db
}

async function initSchema() {
  const db = getDb()
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

// Инициализируем схему БД асинхронно после запуска сервера
// Это не блокирует запуск сервера
const initializeDatabase = async () => {
  try {
    await initSchema()
  } catch (e) {
    console.error('❌ DB init failed', e)
    // Не пробрасываем ошибку - сервер должен работать даже без БД
  }
}

// SQLite миграции удалены: проект использует только PostgreSQL

// Вспомогательные функции для работы с БД
const saveMessageToDB = async (sessionId, role, content, messageOrder) => {
  try {
    const db = getDb()
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
    const db = getDb()
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
    const db = getDb()
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

    const db = getDb()
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

    const db = getDb()
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
  const db = getDb()
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
    const db = getDb()
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

// Схемы будут созданы после загрузки SDK
let InvestmentAgentSchema = null

const initSchemas = () => {
  if (!z) {
    throw new Error('z не загружен. Вызовите loadAgentsSDK() сначала.')
  }
  InvestmentAgentSchema = z.object({
    amount: z.number().nullable().optional(),
    term_months: z.number().nullable().optional(),
    completed: z.boolean().nullable().optional()
  })
}

const transactionClassifierInstructions = `Ты финансовый аналитик iKapitalist. Твоя задача — классифицировать операции, по которым нет однозначного понимания, является ли поступление выручкой от реализации товаров/услуг или нет.

Данные:
- Ты получишь JSON-массив \`transactions_for_review\`.
- Каждая операция имеет как минимум поля \`id\`, \`date\`, \`amount\`, \`purpose\`, иногда \`sender\`/\`comment\`.

Требования:
1. Для каждой операции верни признак \`is_revenue\` (true/false) и короткое объяснение \`reason\`.
2. Считай выручкой только платежи клиентов за товары/услуги или их прямые аналоги ("оплата", "реализация", "invoice", "services", "goods", "договор поставки" и т.п.).
3. Не относись к выручке переводы между собственными счетами, возвраты, займы/кредиты, инвестиции, субсидии, пополнения, депозиты, дивиденды, зарплаты, налоги, штрафы, возврат оплаты клиенту и т.п.
4. Если формулировка явно указывает на невыручку — ставь false.
5. Если формулировка явно указывает на продажу товаров/услуг — ставь true.
6. Если текст нейтральный, но похож на оплату клиента (invoice, payment for contract) — выбирай true.
7. Если сомневаешься между внутренним переводом и оплатой клиента — выбирай false (консервативно) и поясни почему.

Формат ответа — строго JSON без текста:
{
  "transactions": [
    { "id": "tx_1", "is_revenue": true, "reason": "оплата по договору поставки" }
  ]
}`

const createTransactionClassifierAgent = () => {
  if (!Agent) {
    throw new Error('Agents SDK не загружен. Вызовите loadAgentsSDK() сначала.')
  }
  return new Agent({
    name: 'Revenue Classifier',
    instructions: transactionClassifierInstructions,
    model: 'gpt-5-mini',
    modelSettings: { store: true },
  })
}

const safeJsonParse = (value) => {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const MONTH_NAMES_RU = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
]

const REVENUE_KEYWORDS = [
  'оплата',
  'за товар',
  'за товары',
  'за услугу',
  'за услуги',
  'договор',
  'invoice',
  'contract',
  'поставка',
  'продажа',
  'реализац',
  'sales',
  'services',
  'услуги',
  'работы',
  'покупатель',
  'customer',
]

const NON_REVENUE_KEYWORDS = [
  'займ',
  'кредит',
  'loan',
  'return',
  'возврат',
  'перевод',
  'между своими',
  'пополнение',
  'депозит',
  'вклад',
  'refund',
  'transfer',
  'инвести',
  'дивиденды',
  'дивиденд',
  'штраф',
  'налог',
  'tax',
  'penalty',
  'зарплат',
  'з/п',
  'зарплата',
  'salary',
  'членский',
  'membership',
  'взнос',
  'страхов',
]

const normalizeWhitespace = (value) =>
  (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')

const getFieldValue = (transaction, keys) => {
  if (!transaction || typeof transaction !== 'object') return ''
  for (const key of keys) {
    if (transaction[key] !== undefined && transaction[key] !== null) {
      const value = transaction[key]
      if (typeof value === 'string') return value
      if (typeof value === 'number') return value.toString()
    }
  }
  return ''
}

const extractPurpose = (transaction) =>
  normalizeWhitespace(
    getFieldValue(transaction, [
      'Назначение платежа',
      'назначение платежа',
      'Назначение',
      'назначение',
      'Purpose',
      'purpose',
      'Комментарий',
      'comment',
      'description',
      'Description',
      'Details',
    ])
  )

const extractSender = (transaction) =>
  normalizeWhitespace(
    getFieldValue(transaction, [
      'Отправитель',
      'отправитель',
      'Плательщик',
      'плательщик',
      'Контрагент',
      'counterparty',
      'sender',
      'payer',
    ])
  )

const extractAmountRaw = (transaction) =>
  getFieldValue(transaction, [
    'Кредит',
    'credit',
    'Сумма',
    'сумма',
    'Amount',
    'amount',
    'value',
  ])

const sanitizeNumberString = (value) => {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\u00a0/g, '')
    .replace(/[^0-9,.\-]/g, '')
    .replace(',', '.')
    .trim()
}

const parseAmountNumber = (value) => {
  if (value === null || value === undefined) return 0
  const stringValue = typeof value === 'number' ? value.toString() : String(value)
  const sanitized = sanitizeNumberString(stringValue)
  if (!sanitized) return 0
  const parsed = Number(sanitized)
  return Number.isFinite(parsed) ? parsed : 0
}

const tryParseDate = (value) => {
  if (!value) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  const raw = value.toString().trim()
  if (!raw) return null
  const direct = Date.parse(raw)
  if (!Number.isNaN(direct)) return new Date(direct)
  const dotMatch = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/)
  if (dotMatch) {
    const [, dd, mm, yy] = dotMatch
    const day = Number(dd)
    const month = Number(mm) - 1
    const year =
      yy.length === 2 ? Number(yy) + (Number(yy) > 70 ? 1900 : 2000) : Number(yy)
    const date = new Date(Date.UTC(year, month, day))
    return Number.isNaN(date.getTime()) ? null : date
  }
  const monthWords = {
    января: 0,
    февраль: 1,
    февраля: 1,
    март: 2,
    марта: 2,
    апрель: 3,
    апреля: 3,
    май: 4,
    мая: 4,
    июнь: 5,
    июня: 5,
    июль: 6,
    июля: 6,
    август: 7,
    августа: 7,
    сентябрь: 8,
    сентября: 8,
    октябрь: 9,
    октября: 9,
    ноябрь: 10,
    ноября: 10,
    декабрь: 11,
    декабря: 11,
  }
  const wordMatch = raw
    .toLowerCase()
    .match(/^(\d{1,2})\s+([а-яa-z]+)\s+(\d{2,4})$/i)
  if (wordMatch) {
    const [, dd, monthWord, yy] = wordMatch
    const month = monthWords[monthWord]
    if (month !== undefined) {
      const day = Number(dd)
      const year =
        yy.length === 2 ? Number(yy) + (Number(yy) > 70 ? 1900 : 2000) : Number(yy)
      const date = new Date(Date.UTC(year, month, day))
      return Number.isNaN(date.getTime()) ? null : date
    }
  }
  return null
}

const extractTransactionDate = (transaction) => {
  const value = getFieldValue(transaction, [
    'Дата',
    'дата',
    'Date',
    'date',
    'Дата операции',
    'дата операции',
    'Дата платежа',
    'дата платежа',
    'Value Date',
    'value date',
  ])
  return tryParseDate(value)
}

const formatCurrencyKzt = (amount) => {
  const normalized = Number.isFinite(amount) ? amount : 0
  return `${normalized.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} KZT`
}

const classifyTransactionHeuristically = (transaction) => {
  const purpose = extractPurpose(transaction).toLowerCase()
  if (!purpose) {
    return { type: 'ambiguous', reason: 'нет назначения платежа' }
  }
  const contains = (keywords) => keywords.some((keyword) => purpose.includes(keyword))
  if (contains(NON_REVENUE_KEYWORDS)) {
    return { type: 'non_revenue', reason: 'обнаружены маркеры невыручки' }
  }
  if (contains(REVENUE_KEYWORDS)) {
    return { type: 'revenue', reason: 'обнаружены маркеры выручки' }
  }
  return { type: 'ambiguous', reason: 'нет явных маркеров' }
}

const attachInternalTransactionIds = (transactions = [], sessionId) =>
  transactions.map((transaction, index) => {
    const existingId =
      transaction?._ikap_tx_id ||
      transaction?.transaction_id ||
      transaction?.id ||
      transaction?.ID
    const generatedId = existingId || `${sessionId || 'sess'}_${index + 1}`
    return {
      ...transaction,
      _ikap_tx_id: generatedId,
    }
  })

const splitTransactionsByConfidence = (transactions = []) => {
  const obviousRevenue = []
  const needsReview = []

  for (const transaction of transactions) {
    const classification = classifyTransactionHeuristically(transaction)
    if (classification.type === 'revenue') {
      obviousRevenue.push({
        ...transaction,
        _ikap_classification_source: 'heuristic',
        _ikap_classification_reason: classification.reason,
      })
      continue
    }
    needsReview.push({
      ...transaction,
      _ikap_classification_source: 'agent_required',
      _ikap_classification_reason: classification.reason,
      _ikap_possible_non_revenue: classification.type === 'non_revenue',
    })
  }

  return { obviousRevenue, needsReview }
}

const buildClassifierPrompt = (transactions) => {
  const simplified = transactions.map((transaction) => ({
    id: transaction._ikap_tx_id,
    date: getFieldValue(transaction, ['Дата', 'дата', 'Date', 'date']),
    amount: extractAmountRaw(transaction),
    purpose: extractPurpose(transaction),
    sender: extractSender(transaction),
    comment: getFieldValue(transaction, ['Комментарий', 'comment', 'Примечание']),
  }))

  return [
    'Ниже операции, которые нужно классифицировать как выручка или нет.',
    'Верни JSON в соответствии с инструкцией, без дополнительных пояснений.',
    'transactions_for_review:',
    '```json',
    JSON.stringify(simplified, null, 2),
    '```',
  ]
    .filter(Boolean)
    .join('\n')
}

const parseClassifierResponse = (text) => {
  if (!text) return []
  const parsed = safeJsonParse(text)
  if (!parsed) return []
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed.transactions)) return parsed.transactions
  return []
}

const aggregateByYearMonth = (transactions = []) => {
  const yearMap = new Map()

  for (const transaction of transactions) {
    const amount = parseAmountNumber(extractAmountRaw(transaction))
    if (!amount) continue
    const date = extractTransactionDate(transaction)
    if (!date) continue
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth()
    const yearEntry = yearMap.get(year) || { total: 0, months: new Map() }
    yearEntry.total += amount
    const monthValue = yearEntry.months.get(month) || 0
    yearEntry.months.set(month, monthValue + amount)
    yearMap.set(year, yearEntry)
  }

  return Array.from(yearMap.entries())
    .sort(([yearA], [yearB]) => yearA - yearB)
    .map(([year, data]) => ({
      year,
      value: data.total,
      formatted: formatCurrencyKzt(data.total),
      months: Array.from(data.months.entries())
        .sort(([monthA], [monthB]) => monthA - monthB)
        .map(([month, value]) => ({
          month: MONTH_NAMES_RU[month] || String(month + 1),
          value,
          formatted: formatCurrencyKzt(value),
        })),
    }))
}

const computeTrailing12Months = (transactions = []) => {
  const dated = transactions
    .map((transaction) => ({
      amount: parseAmountNumber(extractAmountRaw(transaction)),
      date: extractTransactionDate(transaction),
    }))
    .filter((item) => item.amount && item.date)

  if (!dated.length) {
    return { total: 0, referenceDate: null }
  }

  const referenceDate = dated.reduce(
    (latest, current) => (current.date > latest ? current.date : latest),
    dated[0].date
  )
  const windowStart = new Date(referenceDate)
  windowStart.setUTCDate(1)
  windowStart.setUTCFullYear(referenceDate.getUTCFullYear())
  windowStart.setUTCMonth(referenceDate.getUTCMonth() - 11)

  const total = dated
    .filter((item) => item.date >= windowStart && item.date <= referenceDate)
    .reduce((sum, item) => sum + item.amount, 0)

  return { total, referenceDate }
}

const buildStructuredSummary = ({
  revenueTransactions,
  nonRevenueTransactions,
  stats,
}) => {
  const revenueSummary = aggregateByYearMonth(revenueTransactions)
  const nonRevenueSummary = aggregateByYearMonth(nonRevenueTransactions)
  const totalRevenue = revenueSummary.reduce((sum, year) => sum + year.value, 0)
  const totalNonRevenue = nonRevenueSummary.reduce((sum, year) => sum + year.value, 0)
  const trailing = computeTrailing12Months(revenueTransactions)

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      revenue: {
        value: totalRevenue,
        formatted: formatCurrencyKzt(totalRevenue),
      },
      nonRevenue: {
        value: totalNonRevenue,
        formatted: formatCurrencyKzt(totalNonRevenue),
      },
    },
    revenue: {
      totalValue: totalRevenue,
      totalFormatted: formatCurrencyKzt(totalRevenue),
      years: revenueSummary,
    },
    nonRevenue: {
      totalValue: totalNonRevenue,
      totalFormatted: formatCurrencyKzt(totalNonRevenue),
      years: nonRevenueSummary,
    },
    trailing12MonthsRevenue: {
      value: trailing.total,
      formatted: formatCurrencyKzt(trailing.total),
      referencePeriodEndsAt: trailing.referenceDate
        ? trailing.referenceDate.toISOString()
        : null,
    },
    stats,
  }
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
    const db = getDb()
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

// Защита от дублирования запросов
const activeAnalysisSessions = new Set()

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

  // Защита от дублирования: если для этой сессии уже идет анализ, возвращаем ошибку
  if (activeAnalysisSessions.has(sessionId)) {
    console.warn('⚠️ Попытка запустить анализ для сессии, которая уже обрабатывается:', sessionId)
    return res.status(409).json({
      ok: false,
      code: 'ANALYSIS_IN_PROGRESS',
      message: 'Анализ для этой сессии уже выполняется. Пожалуйста, подождите.',
      sessionId,
    })
  }

  // Помечаем сессию как активную
  activeAnalysisSessions.add(sessionId)

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
    let extractedTransactions = []

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
        console.log(`🔍 Полная структура результатов:`, JSON.stringify(jsonResults, null, 2))
        console.log(`🔍 Структура результатов (краткая):`, JSON.stringify(jsonResults.map((r, idx) => ({
          index: idx,
          type: typeof r,
          isArray: Array.isArray(r),
          keys: r && typeof r === 'object' ? Object.keys(r) : [],
          source_file: r?.source_file,
          has_transactions: !!(r?.transactions),
          transactions_count: r?.transactions ? (Array.isArray(r.transactions) ? r.transactions.length : 'not array') : 0,
          has_error: !!r?.error
        })), null, 2))

        // Объединяем все транзакции из всех файлов
        const allTransactions = []
        const allMetadata = []
        
        for (const result of jsonResults) {
          if (result.error) {
            console.warn(`⚠️ Ошибка при конвертации файла ${result.source_file}: ${result.error}`)
            continue
          }
          
          // Проверяем структуру результата
          if (result.transactions && Array.isArray(result.transactions)) {
            console.log(`📊 Добавляю ${result.transactions.length} транзакций из файла ${result.source_file}`)
            allTransactions.push(...result.transactions)
          } else {
            console.warn(`⚠️ Файл ${result.source_file} не содержит транзакций (transactions: ${typeof result.transactions}, isArray: ${Array.isArray(result.transactions)})`)
          }
          
          if (result.metadata) {
            allMetadata.push({
              source_file: result.source_file,
              ...result.metadata
            })
          }
        }
        
        console.log(`📊 Итого собрано транзакций: ${allTransactions.length}`)

        const transactionsWithInternalIds = attachInternalTransactionIds(allTransactions, sessionId)
        extractedTransactions = transactionsWithInternalIds

        // Создаем JSON файл с результатами конвертации (даже если транзакций нет)
        const jsonData = {
          metadata: allMetadata,
          transactions: transactionsWithInternalIds,
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

        // Загружаем JSON файл в OpenAI Files API для использования в Code Interpreter
        // Это позволяет агенту работать с большими объемами данных через файловую систему
        let jsonFileId = null
        if (allTransactions.length > 0) {
          try {
            console.log(`📤 Загружаем JSON файл в OpenAI Files API: ${jsonFilename} (${jsonBuffer.length} bytes)`)
            const uploadedJsonFile = await openaiClient.files.create({
              file: await toFile(jsonBuffer, jsonFilename, { type: 'application/json' }),
              purpose: 'assistants',
            })
            
            jsonFileId = uploadedJsonFile.id
            console.log('✅ JSON файл загружен в OpenAI', {
              fileId: jsonFileId,
              filename: uploadedJsonFile.filename,
              size: jsonBuffer.length,
              transactions: allTransactions.length,
            })

            // Сохраняем файл в БД
            try {
              await saveFileToDB(
                sessionId,
                jsonFileId,
                jsonFilename,
                jsonBuffer.length,
                'application/json',
                'converted_statement'
              )
            } catch (error) {
              console.error('⚠️ Не удалось сохранить JSON файл в БД, продолжаем работу', error)
            }

            // Добавляем JSON файл в attachments
            attachments.push({
              file_id: jsonFileId,
              original_filename: jsonFilename,
              is_converted: true,
              source_files: pdfFiles.map(f => f.originalname),
              transaction_count: allTransactions.length
            })
          } catch (uploadError) {
            console.error('❌ Ошибка загрузки JSON файла в OpenAI:', uploadError.message)
            // Fallback: если не удалось загрузить файл, используем старый метод (вставка в промпт)
            // Но только если JSON не слишком большой (меньше 100KB)
            if (jsonBuffer.length < 100000) {
              console.warn('⚠️ Используем fallback: вставляем JSON в промпт (файл меньше 100KB)')
              const jsonDataString = JSON.stringify(jsonData, null, 2)
              attachments.push({
                is_converted: true,
                source_files: pdfFiles.map(f => f.originalname),
                json_data: jsonDataString,
                transaction_count: allTransactions.length
              })
            } else {
              throw new Error(`Не удалось загрузить JSON файл (${jsonBuffer.length} bytes) в OpenAI. Файл слишком большой для вставки в промпт.`)
            }
          }
        } else {
          // Если транзакций нет, все равно сохраняем информацию
          attachments.push({
            is_converted: true,
            source_files: pdfFiles.map(f => f.originalname),
            transaction_count: 0
          })
        }
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

    const transactionsWithIds = Array.isArray(extractedTransactions)
      ? extractedTransactions
      : []

    const { obviousRevenue, needsReview } = splitTransactionsByConfidence(transactionsWithIds)
    const classificationStats = {
      totalTransactions: transactionsWithIds.length,
      autoRevenue: obviousRevenue.length,
      agentReviewed: needsReview.length,
    }

    console.log('🧮 Подготовка операций перед классификацией', {
      sessionId,
      ...classificationStats,
    })

    ;(async () => {
      try {
        let runResult = null
        let rawNewItems = []
        let classificationEntries = []

        if (needsReview.length > 0) {
          await loadAgentsSDK()
          if (!analysisRunner) {
            analysisRunner = new Runner({})
          }
          const classifierAgent = createTransactionClassifierAgent()
          const agentInput = [
            {
      role: 'user',
      content: [
        {
          type: 'input_text',
                  text: buildClassifierPrompt(needsReview),
                },
              ],
            },
          ]

          console.log('🤖 Запускаем классификатор операций через Runner (async)', {
      sessionId,
            needsReview: needsReview.length,
          })

          runResult = await analysisRunner.run(classifierAgent, agentInput)

          rawNewItems = Array.isArray(runResult.newItems)
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

          classificationEntries = parseClassifierResponse(finalOutputText)

          console.log('🗂️ Результаты классификации от агента', {
            sessionId,
            parsedTransactions: classificationEntries.length,
            responseId: runResult.lastResponseId,
          })
        }

        const decisionsMap = new Map()
        for (const entry of classificationEntries) {
          if (!entry || !entry.id) continue
          const key = String(entry.id)
          const isRevenue =
            entry.is_revenue ??
            entry.isRevenue ??
            entry.revenue ??
            (entry.label === 'revenue')
          decisionsMap.set(key, {
            isRevenue: Boolean(isRevenue),
            reason: entry.reason || entry.explanation || '',
          })
        }

        const reviewedRevenue = []
        const reviewedNonRevenue = []

        for (const transaction of needsReview) {
          const decision =
            decisionsMap.get(String(transaction._ikap_tx_id)) ||
            decisionsMap.get(transaction._ikap_tx_id)
          const isRevenue = decision ? decision.isRevenue : false
          const reason =
            decision?.reason ||
            (decision ? '' : 'нет решения от агента, по умолчанию не выручка')

          const enriched = {
            ...transaction,
            _ikap_classification_source: decision ? 'agent' : 'agent_missing',
            _ikap_classification_reason: reason,
          }

          if (isRevenue) {
            reviewedRevenue.push(enriched)
          } else {
            reviewedNonRevenue.push(enriched)
          }
        }

        const finalRevenueTransactions = [...obviousRevenue, ...reviewedRevenue]
        const finalNonRevenueTransactions = reviewedNonRevenue

        const structuredSummary = buildStructuredSummary({
          revenueTransactions: finalRevenueTransactions,
          nonRevenueTransactions: finalNonRevenueTransactions,
          stats: {
            ...classificationStats,
            agentDecisions: decisionsMap.size,
            unresolved: Math.max(0, needsReview.length - decisionsMap.size),
          },
        })

        const completedAt = new Date().toISOString()
        const finalReportPayload = JSON.stringify(structuredSummary, null, 2)
        const openaiStatus =
          needsReview.length === 0 ? 'skipped' : decisionsMap.size > 0 ? 'completed' : 'partial'

        await upsertReport(sessionId, {
          status: 'completed',
          reportText: finalReportPayload,
          filesCount: files.length,
          filesData: filesDataJson,
          completed: completedAt,
          comment,
          openaiResponseId: runResult?.lastResponseId || null,
          openaiStatus,
        })

        console.log('📦 Классификация операций завершена (async)', {
          sessionId,
          durationMs: Date.now() - startedAt.getTime(),
          totalTransactions: transactionsWithIds.length,
          autoRevenue: obviousRevenue.length,
          reviewedByAgent: needsReview.length,
          agentDecisions: decisionsMap.size,
        })
      } catch (streamError) {
        console.error('❌ Ошибка в фоне при обработке классификации', {
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
      } finally {
        // Освобождаем сессию после завершения анализа
        activeAnalysisSessions.delete(sessionId)
      }
    })().catch((unhandled) => {
      console.error('❌ Необработанная ошибка фоновой классификации', {
        sessionId,
        error: unhandled?.message || unhandled,
      })
      // Освобождаем сессию даже при необработанной ошибке
      activeAnalysisSessions.delete(sessionId)
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

    // Освобождаем сессию при ошибке
    activeAnalysisSessions.delete(sessionId)

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
    const db = getDb()
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
    const db = getDb()
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
    const db = getDb()
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

// Запускаем сервер СРАЗУ, до всех тяжелых операций
// Это критично для Render.com - health check должен отвечать быстро
console.log(`⏳ Запуск сервера на порту ${port}...`)
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`✅ HTTP сервер запущен и слушает на порту ${port}`)
  console.log(`📡 Health check: http://0.0.0.0:${port}/health`)
  console.log(`🏥 Ping: http://0.0.0.0:${port}/ping`)
  console.log(`🚀 Backend iKapitalist готов принимать запросы`)
  
  // Инициализируем БД асинхронно после запуска сервера
  initializeDatabase().catch((error) => {
    console.error('⚠️ Ошибка инициализации БД (будет повторена при первом запросе):', error.message)
  })
  
  // Загружаем Agents SDK асинхронно после запуска сервера
  // Это не блокирует health check
  loadAgentsSDK()
    .then(() => {
      initSchemas()
      analysisRunner = new Runner({})
      console.log('✅ Agents SDK инициализирован, анализ готов к работе')
    })
    .catch((error) => {
      console.error('⚠️ Ошибка инициализации Agents SDK (будет загружен при первом запросе):', error.message)
    })
})

// Обработка graceful shutdown для Render.com и других платформ
const gracefulShutdown = (signal) => {
  console.log(`\n📛 Получен сигнал ${signal}, начинаем graceful shutdown...`)
  
  server.close(async (err) => {
    if (err) {
      console.error('❌ Ошибка при закрытии сервера:', err)
      process.exit(1)
    }
    
    console.log('✅ HTTP сервер закрыт')
    
    // Закрываем соединение с БД, если есть метод close
    try {
      const dbInstance = db // Используем переменную из замыкания
      if (dbInstance && typeof dbInstance.close === 'function') {
        await dbInstance.close()
        console.log('✅ Соединение с БД закрыто')
      }
    } catch (dbError) {
      console.error('⚠️ Ошибка при закрытии БД:', dbError)
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

