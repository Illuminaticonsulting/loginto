/**
 * LogInTo — User Store
 *
 * JSON file-based user management.
 * Password IS the identity — no usernames needed.
 * Each user gets a unique agentKey for their desktop agent.
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

class UserStore {
  constructor() {
    this.users = [];
  }

  /**
   * Initialize: load or seed users
   */
  async init() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      this.users = JSON.parse(data);
      console.log(`👥 Loaded ${this.users.length} users`);
    } else {
      await this._seed();
    }
  }

  /**
   * Seed default users on first run
   */
  async _seed() {
    console.log('👥 Creating default users...');

    this.users = [
      {
        id: 'kingpin',
        displayName: 'Kingpin',
        passwordHash: await bcrypt.hash('kingpin', 12),
        agentKey: uuidv4()
      },
      {
        id: 'tez',
        displayName: 'Tez',
        passwordHash: await bcrypt.hash('tez', 12),
        agentKey: uuidv4()
      }
    ];

    this._save();
    console.log('   ✅ Created users: kingpin, tez');
    console.log('');
  }

  /**
   * Save users to disk
   */
  _save() {
    fs.writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2));
  }

  /**
   * Authenticate by password (password IS the identity)
   * Returns user object (without sensitive fields) or null
   */
  async authenticateByPassword(password) {
    for (const user of this.users) {
      const match = await bcrypt.compare(password, user.passwordHash);
      if (match) {
        return {
          id: user.id,
          displayName: user.displayName
        };
      }
    }
    return null;
  }

  /**
   * Authenticate a desktop agent by its key
   * Returns user object or null
   */
  getByAgentKey(agentKey) {
    const user = this.users.find(u => u.agentKey === agentKey);
    if (!user) return null;
    return {
      id: user.id,
      displayName: user.displayName
    };
  }

  /**
   * Get user by ID
   */
  getById(id) {
    const user = this.users.find(u => u.id === id);
    if (!user) return null;
    return {
      id: user.id,
      displayName: user.displayName
    };
  }

  /**
   * Get agent key for a specific user (shown on dashboard)
   */
  getAgentKey(userId) {
    const user = this.users.find(u => u.id === userId);
    return user ? user.agentKey : null;
  }

  /**
   * Get all users (safe — no passwords or keys)
   */
  getAllUsers() {
    return this.users.map(u => ({
      id: u.id,
      displayName: u.displayName
    }));
  }
}

module.exports = new UserStore();
