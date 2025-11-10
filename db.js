const { Pool } = require('pg')

const createPgDb = () => {
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.PG_CONNECTION_STRING ||
    process.env.POSTGRES_URL ||
    process.env.SUPABASE_DB_URL

  if (!connectionString) {
    throw new Error(
      'Не указана строка подключения к PostgreSQL. Задайте переменную окружения DATABASE_URL.'
    )
  }

  const pool = new Pool({
    connectionString,
    ssl:
      process.env.PGSSL === 'disable'
        ? false
        : {
            rejectUnauthorized: false,
          },
  })

  const convertPlaceholders = (sql) => {
    let index = 0
    return sql.replace(/\?/g, () => {
      index += 1
      return `$${index}`
    })
  }

  const exec = async (sql) => {
    await pool.query(sql)
  }

  const prepare = (sql) => {
    const pgSql = convertPlaceholders(sql)
    return {
      run: async (...params) => {
        await pool.query(pgSql, params)
      },
      all: async (...params) => {
        const result = await pool.query(pgSql, params)
        return result.rows
      },
      get: async (...params) => {
        const result = await pool.query(pgSql, params)
        return result.rows[0] || null
      },
    }
  }

  return {
    type: 'pg',
    exec,
    prepare,
    pool,
    close: async () => pool.end(),
  }
}

module.exports = {
  createDb: () => createPgDb(),
}

