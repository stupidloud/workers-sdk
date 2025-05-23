import assert from "node:assert";
import { fetchResult } from "./cfetch";
import { configFileName } from "./config";
import { logger } from "./logger";
import type { Config } from "./config";
import type { CfWorkerInit } from "./deployment-bundle/worker";

/**
 * For a given Worker + migrations config, figure out which migrations
 * to upload based on the current migration tag of the deployed Worker.
 */
export async function getMigrationsToUpload(
	scriptName: string,
	props: {
		accountId: string | undefined;
		config: Config;
		legacyEnv: boolean | undefined;
		env: string | undefined;
		dispatchNamespace: string | undefined;
	}
): Promise<CfWorkerInit["migrations"]> {
	const { config, accountId } = props;

	assert(accountId, "Missing accountId");
	// if config.migrations
	let migrations;
	if (config.migrations.length > 0) {
		// get current migration tag
		type ScriptData = { id: string; migration_tag?: string };
		let script: ScriptData | undefined;
		if (props.dispatchNamespace) {
			try {
				const scriptData = await fetchResult<{ script: ScriptData }>(
					config,
					`/accounts/${accountId}/workers/dispatch/namespaces/${props.dispatchNamespace}/scripts/${scriptName}`
				);
				script = scriptData.script;
			} catch (err) {
				suppressNotFoundError(err);
			}
		} else {
			if (!props.legacyEnv) {
				try {
					if (props.env) {
						const scriptData = await fetchResult<{
							script: ScriptData;
						}>(
							config,
							`/accounts/${accountId}/workers/services/${scriptName}/environments/${props.env}`
						);
						script = scriptData.script;
					} else {
						const scriptData = await fetchResult<{
							default_environment: {
								script: ScriptData;
							};
						}>(config, `/accounts/${accountId}/workers/services/${scriptName}`);
						script = scriptData.default_environment.script;
					}
				} catch (err) {
					suppressNotFoundError(err);
				}
			} else {
				const scripts = await fetchResult<ScriptData[]>(
					config,
					`/accounts/${accountId}/workers/scripts`
				);
				script = scripts.find(({ id }) => id === scriptName);
			}
		}

		if (script?.migration_tag) {
			// was already published once
			const scriptMigrationTag = script.migration_tag;
			const foundIndex = config.migrations.findIndex(
				(migration) => migration.tag === scriptMigrationTag
			);
			if (foundIndex === -1) {
				logger.warn(
					`The published script ${scriptName} has a migration tag "${script.migration_tag}, which was not found in your ${configFileName(config.configPath)} file. You may have already deleted it. Applying all available migrations to the script...`
				);
				migrations = {
					old_tag: script.migration_tag,
					new_tag: config.migrations[config.migrations.length - 1].tag,
					steps: config.migrations.map(({ tag: _tag, ...rest }) => rest),
				};
			} else {
				if (foundIndex !== config.migrations.length - 1) {
					// there are new migrations to send up
					migrations = {
						old_tag: script.migration_tag,
						new_tag: config.migrations[config.migrations.length - 1].tag,
						steps: config.migrations
							.slice(foundIndex + 1)
							.map(({ tag: _tag, ...rest }) => rest),
					};
				}
				// else, we're up to date, no migrations to send
			}
		} else {
			// first time publishing durable objects to this script,
			// so we send all the migrations
			migrations = {
				new_tag: config.migrations[config.migrations.length - 1].tag,
				steps: config.migrations.map(({ tag: _tag, ...rest }) => rest),
			};
		}
	}
	return migrations;
}

const suppressNotFoundError = (err: unknown) => {
	if (
		![
			10090, // corresponds to workers.api.error.service_not_found, so the script wasn't previously published at all
			10092, // workers.api.error.environment_not_found, so the script wasn't published to this environment yet
		].includes((err as { code: number }).code)
	) {
		throw err;
	}
	// else it's a 404, no script found, and we can proceed
};
