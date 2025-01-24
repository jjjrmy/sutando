#!/usr/bin/env node
const { program } = require('commander');
const path = require('path');
const { promisify } = require('util');
const fs = require('fs');
const color = require('colorette');
const resolveFrom = require('resolve-from');
const snakeCase = require('lodash/snakeCase');

const { success, exit, twoColumnDetail, findUpConfig, findUpModulePath, findModulePkg, TableGuesser, localModuleCheck, getMigrationPaths } = require('./utils');
const cliPkg = require('../package');

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);

const env = {
  modulePath: findModulePkg('sutando') || resolveFrom.silent(process.cwd(), 'sutando') || findUpModulePath(process.cwd(), 'sutando'),
  cwd: process.cwd(),
  configPath: findUpConfig(process.cwd(), 'sutando.config', ['js', 'cjs'])
}

let modulePackage = {};

try {
  modulePackage = require(path.join(
    env.modulePath,
    'package.json'
  ));
} catch (e) {
  /* empty */
}

function getSutandoModule(modulePath) {
  localModuleCheck(env);
  return require(path.join(
    env.modulePath,
    modulePath
  ));
}

const cliVersion = [
  'Sutando CLI version:',
  color.green(cliPkg.version),
].join(' ');

const localVersion = [
  'Sutando Local version:',
  color.green(modulePackage.version || 'None'),
].join(' ');

program
  .name('sutando')
  .version(`${cliVersion}\n${localVersion}`);

program
  .command('init')
  .description('Create a fresh sutando config.')
  .action(async () => {
    localModuleCheck(env);
    const type = 'js';
    if (env.configPath) {
      exit(`Error: ${env.configPath} already exists`);
    }

    try {
      const stubPath = `./sutando.config.${type}`;
      const code = await readFile(
        env.modulePath +
          '/src/stubs/sutando.config-' +
          type +
          '.stub'
      );
      await writeFile(stubPath, code);
          
      success(color.green(`Created ${stubPath}`));
    } catch(e) {
      exit(e);
    }
  });

program
  .command('migrate:make <name>')
  .description('Create a new migration file.')
  .option(`--table`, 'The table to migrate')
  .option(`--create`, 'The table to be created')
  .action(async (name, opts) => {
    if (!env.configPath) {
      exit('Error: sutando config not found. Run `sutando init` first.');
    }

    const config = require(env.configPath);

    try {
      name = snakeCase(name);
      let table = opts.table;
      let create = opts.create || false;

      if (!table && typeof create === 'string') {
        table = create;
        create = true;
      }

      if (!table) {
        const guessed = TableGuesser.guess(name);
        table = guessed[0];
        create = guessed[1];
      }

      const MigrationCreator = getSutandoModule('src/migrations/migration-creator');
      const creator = new MigrationCreator('');
      const fileName = await creator.create(name, env.cwd + `/${config?.migrations?.path || 'migrations'}`, table, create);

      success(color.green(`Created Migration: ${fileName}`));
    } catch (err) {
      exit(err);
    }
  });

program
  .command('migrate:publish <package>')
  .description('Publish any migration files from packages.')
  .action(async (package, opts) => {
    if (!env.configPath) {
      exit('Error: sutando config not found. Run `sutando init` first.');
    }

    const config = require(env.configPath);

    try {
      const packagePath = findModulePkg(package);

      if (!packagePath) {
        exit(`Error: package ${package} not found`);
      }

      const MigrationCreator = getSutandoModule('src/migrations/migration-creator');
      const creator = new MigrationCreator(path.join(packagePath, 'migrations'));

      console.log(color.green(`Publishing migrations:`));
      const fileNames = await creator.publish(env.cwd + `/${config?.migrations?.path || 'migrations'}`, (fileName, oldPath, newPath) => {
        console.log(newPath + ' ' + color.green(`DONE`));
      });
    } catch (err) {
      exit(err);
    }
  });

program
  .command('migrate:run')
  .description('Run all pending migrations.')
  .option('--step', 'Force the migrations to be run so they can be rolled back individually.')
  .option('--path <path>', 'The path to the migrations directory.')
  .action(async (opts) => {
    if (!env.configPath) {
      exit('Error: sutando config not found. Run `sutando init` first.');
    }

    const config = require(env.configPath);
    
    try {
      const { migrateRun } = getSutandoModule('src/migrate');
      await migrateRun(config, opts, true);
    } catch (err) {
      exit(err);
    }
  });

program
  .command('migrate:rollback')
  .description('Rollback the last database migration.')
  .option('--step <number>', 'The number of migrations to be reverted.')
  .option('--path <path>', 'The path to the migrations directory.')
  .action(async (opts) => {
    if (!env.configPath) {
      exit('Error: sutando config not found. Run `sutando init` first.');
    }

    const config = require(env.configPath);
    
    try {
      const { migrateRollback } = getSutandoModule('src/migrate');
      await migrateRollback(config, opts, true);
    } catch (err) {
      exit(err);
    }
  });

program
  .command('migrate:status')
  .description('Show the status of each migration.')
  .option('--path <path>', 'The path to the migrations directory.')
  .action(async (opts) => {
    if (!env.configPath) {
      exit('Error: sutando config not found. Run `sutando init` first.');
    }

    const config = require(env.configPath);
    
    try {
      const { migrateStatus } = getSutandoModule('src/migrate');
      const migrations = await migrateStatus(config, opts, true);

      if (migrations.length > 0) {
        twoColumnDetail(color.gray('Migration name'), color.gray('Batch / Status'));

        migrations.forEach(migration => {
          const status = migration.ran 
            ? `[${migration.batch}] ${color.green('Ran')}`
            : color.yellow('Pending');
          twoColumnDetail(migration.name, status);
        });
      } else {
        console.log('No migrations found');
      }
    } catch (err) {
      exit(err);
    }
  });

program
  .command('migrate:export')
  .description('Export migrations to SQL files.')
  .option('--path <path>', 'The path to the migrations directory.')
  .option('--output <path>', 'The path where SQL files will be saved.', '.sql')
  .action(async (opts) => {
    if (!env.configPath) {
      exit('Error: sutando config not found. Run `sutando init` first.');
    }

    const config = require(env.configPath);
    
    try {
      // Setup sutando with minimal pool settings
      const sutando = getSutandoModule('./sutando');
      const MigrationRepository = getSutandoModule('./migrations/migration-repository');
      const Migrator = getSutandoModule('./migrations/migrator');
      
      const table = config?.migration?.table || 'migrations';
      sutando.addConnection({
        ...config,
        connection: {},
        pool: { 
          min: 0,
          max: 0,
          acquireTimeoutMillis: 1,
          createTimeoutMillis: 1,
          destroyTimeoutMillis: 1,
          idleTimeoutMillis: 1,
          reapIntervalMillis: 1,
          createRetryIntervalMillis: 1,
        }
      }, 'default');

      Object.entries(config.connections || {}).forEach(([name, connection]) => {
          sutando.addConnection({
            ...connection,
            connection: {},
            pool: { 
              min: 0,
              max: 0,
              acquireTimeoutMillis: 1,
              createTimeoutMillis: 1,
              destroyTimeoutMillis: 1,
              idleTimeoutMillis: 1,
              reapIntervalMillis: 1,
              createRetryIntervalMillis: 1,
            }
          }, name);
      });

      const repository = new MigrationRepository(sutando, table);
      const migrator = new Migrator(repository, sutando);

      // Get migration paths and base directory
      const migrationsDir = path.join(process.cwd(), config?.migrations?.path || 'migrations');
      const paths = await getMigrationPaths(process.cwd(), migrator, config?.migrations?.path, opts.path);
      
      // Create output directory within migrations folder
      const outputDir = path.join(migrationsDir, opts.output);
      await promisify(fs.mkdir)(outputDir, { recursive: true });

      // Process each migration file
      for (const migrationPath of paths) {
        try {
          const migration = require(migrationPath);
          const instance = new migration();
          const name = path.basename(migrationPath, '.js');
          
          // Capture up SQL
          const upSchema = sutando.schema();
          await instance.up(upSchema);
          const upSql = upSchema.toSQL();
          
          if (upSql.length > 0) {
            const upFilePath = path.join(outputDir, `${name}-up.sql`);
            await writeFile(upFilePath, upSql.map(q => q.sql).join(';\n\n') + ';');
            console.log(color.green(`Generated up SQL for ${name}`));
          }

          // Reset schema
          sutando.schema().clear();

          // Capture down SQL
          const downSchema = sutando.schema();
          await instance.down(downSchema);
          const downSql = downSchema.toSQL();
          
          if (downSql.length > 0) {
            const downFilePath = path.join(outputDir, `${name}-down.sql`);
            await writeFile(downFilePath, downSql.map(q => q.sql).join(';\n\n') + ';');
            console.log(color.green(`Generated down SQL for ${name}`));
          }
        } catch (err) {
          console.error(color.red(`Error processing ${path.basename(migrationPath)}: ${err.message}`));
        }
      }

      success(color.green(`SQL files exported to ${opts.output}/`));
    } catch (err) {
      exit(err);
    }
  });

program
  .command('model:make <name>')
  .description('Create a new Model file.')
  .option('--force', 'Force creation if model already exists.', false)
  .action(async (name, opts) => {
    if (!env.configPath) {
      exit('Error: sutando config not found. Run `sutando init` first.');
    }
    
    const config = require(env.configPath);

    try {
      const modelPath = path.join(env.cwd, config?.models?.path || 'models', name?.toLowerCase() + '.js');

      if (!opts.force  && fs.existsSync(modelPath)) {
        exit(`Model already exists.`);
      }

      await promisify(fs.mkdir)(path.dirname(modelPath), { recursive: true });

      const stubPath = path.join(
        env.modulePath,
        'src/stubs/model-js.stub'
      );
      let stub = await readFile(stubPath, 'utf-8');
      stub = stub.replace(/{{ name }}/g, name);
      await writeFile(modelPath, stub);

      success(color.green(`Created Model: ${modelPath}`));
    } catch (err) {
      exit(err);
    }
  });

program.parse();
