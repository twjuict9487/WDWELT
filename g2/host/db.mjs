import mysql from 'mysql2/promise';
import { databaseConnectionOptions } from '../../db/config.mjs';

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_PACKETS_OUT_OF_ORDER',
  'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'ER_CON_COUNT_ERROR', 'ER_SERVER_SHUTDOWN',
]);

export class DatabaseUnavailableError extends Error {
  constructor(message = '中央資料目前無法使用') {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

function withTimeout(promise, milliseconds) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new DatabaseUnavailableError('Database readiness timeout')), milliseconds); }),
  ]).finally(() => clearTimeout(timeout));
}

export class DatabaseManager {
  #config;
  #log;
  #pool;
  #ready = false;
  #lastCheck = null;
  #retrySeconds;
  #retryTimer = null;
  #closed = false;
  #cleanupTimer = null;
  #everReady = false;
  #readyCheck = null;
  #unavailableLogged = false;

  constructor(config, log = () => {}) {
    this.#config = config;
    this.#log = log;
    this.#retrySeconds = config.reconnectInitialSeconds;
    this.#pool = mysql.createPool(databaseConnectionOptions(config, {
      waitForConnections: true,
      connectionLimit: config.connectionLimit,
      queueLimit: 20,
      connectTimeout: config.connectTimeoutMs,
      decimalNumbers: true,
      enableKeepAlive: true,
    }));
  }

  get config() { return this.#config; }
  get status() { return { ready: this.#ready, lastCheck: this.#lastCheck }; }

  start() {
    void this.checkReady();
    this.#cleanupTimer = setInterval(() => {
      void this.execute('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP(3)').catch(() => {});
    }, this.#config.sessionCleanupMinutes * 60_000);
    this.#cleanupTimer.unref();
  }

  #markUnavailable(error) {
    const wasReady = this.#ready;
    this.#ready = false;
    this.#lastCheck = new Date().toISOString();
    if (wasReady || !this.#unavailableLogged) this.#log('error', 'db_unavailable', 'MySQL connection is unavailable.');
    this.#unavailableLogged = true;
    this.#scheduleRetry();
    if (error instanceof DatabaseUnavailableError) return error;
    return new DatabaseUnavailableError();
  }

  #scheduleRetry() {
    if (this.#closed || this.#retryTimer) return;
    const wait = this.#retrySeconds * 1000;
    this.#retrySeconds = Math.min(this.#retrySeconds * 2, this.#config.reconnectMaxSeconds);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.checkReady();
    }, wait);
    this.#retryTimer.unref();
  }

  async checkReady() {
    if (this.#closed) return false;
    if (this.#readyCheck) return this.#readyCheck;
    const pending = this.#performReadyCheck();
    this.#readyCheck = pending;
    try { return await pending; }
    finally { if (this.#readyCheck === pending) this.#readyCheck = null; }
  }

  async #performReadyCheck() {
    try {
      await withTimeout(this.#pool.query('SELECT 1'), this.#config.readyTimeoutMs);
      const wasReady = this.#ready;
      this.#ready = true;
      this.#lastCheck = new Date().toISOString();
      this.#retrySeconds = this.#config.reconnectInitialSeconds;
      this.#unavailableLogged = false;
      if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = null; }
      if (!wasReady) this.#log('info', this.#everReady ? 'db_reconnect' : 'db_connect', 'MySQL connection is ready.');
      this.#everReady = true;
      return true;
    } catch (error) {
      this.#markUnavailable(error);
      return false;
    }
  }

  async execute(sql, parameters = []) {
    try {
      const [result] = await this.#pool.execute(sql, parameters);
      if (!this.#ready) await this.checkReady();
      return result;
    } catch (error) {
      if (CONNECTION_ERROR_CODES.has(error?.code) || error?.fatal) throw this.#markUnavailable(error);
      throw error;
    }
  }

  async query(sql, parameters = []) {
    try {
      const [rows] = await this.#pool.query(sql, parameters);
      if (!this.#ready) await this.checkReady();
      return rows;
    } catch (error) {
      if (CONNECTION_ERROR_CODES.has(error?.code) || error?.fatal) throw this.#markUnavailable(error);
      throw error;
    }
  }

  async transaction(operation) {
    let connection;
    try {
      connection = await this.#pool.getConnection();
      await connection.beginTransaction();
      const adapter = {
        execute: async (sql, parameters = []) => (await connection.execute(sql, parameters))[0],
        query: async (sql, parameters = []) => (await connection.query(sql, parameters))[0],
      };
      const value = await operation(adapter);
      await connection.commit();
      return value;
    } catch (error) {
      if (connection) { try { await connection.rollback(); } catch { /* original error wins */ } }
      if (CONNECTION_ERROR_CODES.has(error?.code) || error?.fatal) throw this.#markUnavailable(error);
      throw error;
    } finally {
      connection?.release();
    }
  }

  async currentMigration() {
    try {
      const rows = await this.query('SELECT migration_id FROM schema_migrations ORDER BY migration_id DESC LIMIT 1');
      return rows[0]?.migration_id ?? 'none';
    } catch { return 'unavailable'; }
  }

  async hasMigration(migrationId, checksum) {
    try {
      const rows = await this.execute('SELECT checksum FROM schema_migrations WHERE migration_id = ? LIMIT 1', [migrationId]);
      return rows[0]?.checksum === checksum;
    } catch { return false; }
  }

  async close() {
    this.#closed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer);
    await this.#pool.end();
  }
}

export class UnavailableDatabaseManager {
  constructor(config = {}, log = () => {}) {
    this.config = { sessionDurationHours: 12, ...config };
    this.log = log;
  }
  get status() { return { ready: false, lastCheck: null }; }
  start() { this.log('error', 'db_unavailable', 'Database configuration is unavailable.'); }
  async checkReady() { return false; }
  async execute() { throw new DatabaseUnavailableError(); }
  async query() { throw new DatabaseUnavailableError(); }
  async transaction() { throw new DatabaseUnavailableError(); }
  async currentMigration() { return 'unavailable'; }
  async hasMigration() { return false; }
  async close() {}
}
