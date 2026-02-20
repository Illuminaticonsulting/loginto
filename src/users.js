/**
 * LogInTo — User Store
 *
 * JSON file-based user management.
 * Password IS the identity — no usernames needed.
 * Each user can have multiple machines, each with a unique agentKey.
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
      // Migrate: convert legacy single agentKey → machines array
      let migrated = false;
      for (const user of this.users) {
        if (user.agentKey && !user.machines) {
          user.machines = [
            { id: 'm1', name: 'My Laptop', agentKey: user.agentKey }
          ];
          delete user.agentKey;
          migrated = true;
        }
        if (!user.machines) {
          user.machines = [];
        }
      }
      if (migrated) this._save();
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
        machines: [{ id: 'm1', name: 'My Laptop', agentKey: uuidv4() }]
      },
      {
        id: 'tez',
        displayName: 'Tez',
        passwordHash: await bcrypt.hash('tez', 12),
        machines: [{ id: 'm1', name: 'My Laptop', agentKey: uuidv4() }]
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
   */
  async authenticateByPassword(password) {
    for (const user of this.users) {
      const match = await bcrypt.compare(password, user.passwordHash);
      if (match) {
        return { id: user.id, displayName: user.displayName };
      }
    }
    return null;
  }

  /**
   * Authenticate a desktop agent by its key
   * Returns user + machine info, or null
   */
  getByAgentKey(agentKey) {
    for (const user of this.users) {
      const machine = (user.machines || []).find(m => m.agentKey === agentKey);
      if (machine) {
        return {
          id: user.id,
          displayName: user.displayName,
          machineId: machine.id,
          machineName: machine.name
        };
      }
    }
    return null;
  }

  /**
   * Get user by ID
   */
  getById(id) {
    const user = this.users.find(u => u.id === id);
    if (!user) return null;
    return { id: user.id, displayName: user.displayName };
  }

  /**
   * Get all machines for a user
   */
  getMachines(userId) {
    const user = this.users.find(u => u.id === userId);
    if (!user) return [];
    return (user.machines || []).map(m => ({
      id: m.id,
      name: m.name,
      agentKey: m.agentKey
    }));
  }

  /**
   * Get a specific machine for a user
   */
  getMachine(userId, machineId) {
    const user = this.users.find(u => u.id === userId);
    if (!user) return null;
    return (user.machines || []).find(m => m.id === machineId) || null;
  }

  /**
   * Add a new machine for a user
   */
  addMachine(userId, name) {
    const user = this.users.find(u => u.id === userId);
    if (!user) return null;
    if (!user.machines) user.machines = [];
    const nextNum = user.machines.length + 1;
    const machine = {
      id: 'm' + Date.now(),
      name: name || `Machine ${nextNum}`,
      agentKey: uuidv4()
    };
    user.machines.push(machine);
    this._save();
    return machine;
  }

  /**
   * Remove a machine
   */
  removeMachine(userId, machineId) {
    const user = this.users.find(u => u.id === userId);
    if (!user || !user.machines) return false;
    const idx = user.machines.findIndex(m => m.id === machineId);
    if (idx === -1) return false;
    user.machines.splice(idx, 1);
    this._save();
    return true;
  }

  /**
   * Rename a machine
   */
  renameMachine(userId, machineId, newName) {
    const user = this.users.find(u => u.id === userId);
    if (!user || !user.machines) return false;
    const machine = user.machines.find(m => m.id === machineId);
    if (!machine) return false;
    machine.name = newName;
    this._save();
    return true;
  }

  /**
   * Legacy compat — get first agent key for a user
   */
  getAgentKey(userId) {
    const machines = this.getMachines(userId);
    return machines.length > 0 ? machines[0].agentKey : null;
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
