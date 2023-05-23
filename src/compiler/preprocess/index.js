import { getLocator } from 'locate-character';
import {
	MappedCode,
	parse_attached_sourcemap,
	sourcemap_add_offset,
	combine_sourcemaps
} from '../utils/mapped_code.js';
import { decode_map } from './decode_sourcemap.js';
import { replace_in_code, slice_source } from './replace_in_code.js';
import { regex_whitespaces } from '../utils/patterns.js';

const regex_filepath_separator = /[/\\]/;

/**
 * @param {string} filename
 */
function get_file_basename(filename) {
	return filename.split(regex_filepath_separator).pop();
}

/**
 * Represents intermediate states of the preprocessing.
 */
class PreprocessResult {
	/** @type {string} */
	source;
	/** @type {string | undefined} */
	filename;

	// sourcemap_list is sorted in reverse order from last map (index 0) to first map (index -1)
	// so we use sourcemap_list.unshift() to add new maps
	// https://github.com/ampproject/remapping#multiple-transformations-of-a-file

	/**
	 * @default []
	 * @type {Array<import('@ampproject/remapping').DecodedSourceMap | import('@ampproject/remapping').RawSourceMap>}
	 */
	sourcemap_list = [];

	/**
	 * @default []
	 * @type {string[]}
	 */
	dependencies = [];

	/**
	 * @type {string}
	 */
	file_basename = undefined;

	/**
	 * @type {ReturnType<typeof getLocator>}
	 */
	get_location = undefined;

	/**
	 *
	 * @param {string} source
	 * @param {string} [filename]
	 */
	constructor(source, filename) {
		this.source = source;
		this.filename = filename;
		this.update_source({ string: source });
		// preprocess source must be relative to itself or equal null
		this.file_basename = filename == null ? null : get_file_basename(filename);
	}

	/**
	 * @param {import('./private.js').SourceUpdate} opts
	 */
	update_source({ string: source, map, dependencies }) {
		if (source != null) {
			this.source = source;
			this.get_location = getLocator(source);
		}
		if (map) {
			this.sourcemap_list.unshift(map);
		}
		if (dependencies) {
			this.dependencies.push(...dependencies);
		}
	}

	/**
	 * @returns {import('./public.js').Processed}
	 */
	to_processed() {
		// Combine all the source maps for each preprocessor function into one
		const map = combine_sourcemaps(this.file_basename, this.sourcemap_list);
		return {
			// TODO return separated output, in future version where svelte.compile supports it:
			// style: { code: styleCode, map: styleMap },
			// script { code: scriptCode, map: scriptMap },
			// markup { code: markupCode, map: markupMap },
			code: this.source,
			dependencies: [...new Set(this.dependencies)],
			map,
			toString: () => this.source
		};
	}
}
/**
 * Convert preprocessor output for the tag content into MappedCode
 * @param {import('./public.js').Processed} processed
 * @param {{ line: number; column: number; }} location
 * @param {string} file_basename
 * @returns {MappedCode}
 */
function processed_content_to_code(processed, location, file_basename) {
	// Convert the preprocessed code and its sourcemap to a MappedCode

	/**
	 * @type {import('@ampproject/remapping').DecodedSourceMap}
	 */
	let decoded_map;
	if (processed.map) {
		decoded_map = decode_map(processed);
		// decoded map may not have sources for empty maps like `{ mappings: '' }`
		if (decoded_map.sources) {
			// offset only segments pointing at original component source
			const source_index = decoded_map.sources.indexOf(file_basename);
			if (source_index !== -1) {
				sourcemap_add_offset(decoded_map, location, source_index);
			}
		}
	}
	return MappedCode.from_processed(processed.code, decoded_map);
}
/**
 * Given the whole tag including content, return a `MappedCode`
 * representing the tag content replaced with `processed`.
 * @param {import('./public.js').Processed} processed
 * @param {'style' | 'script'} tag_name
 * @param {string} attributes
 * @param {import('./private.js').Source} source
 * @returns {MappedCode}
 */
function processed_tag_to_code(processed, tag_name, attributes, source) {
	const { file_basename, get_location } = source;

	/**
	 * @param {string} code
	 * @param {number} offset
	 */
	const build_mapped_code = (code, offset) =>
		MappedCode.from_source(slice_source(code, offset, source));
	const tag_open = `<${tag_name}${attributes || ''}>`;
	const tag_close = `</${tag_name}>`;
	const tag_open_code = build_mapped_code(tag_open, 0);
	const tag_close_code = build_mapped_code(tag_close, tag_open.length + source.source.length);
	parse_attached_sourcemap(processed, tag_name);
	const content_code = processed_content_to_code(
		processed,
		get_location(tag_open.length),
		file_basename
	);
	return tag_open_code.concat(content_code).concat(tag_close_code);
}
const regex_quoted_value = /^['"](.*)['"]$/;

/**
 * @param {string} str
 */
function parse_tag_attributes(str) {
	// note: won't work with attribute values containing spaces.
	return str
		.split(regex_whitespaces)
		.filter(Boolean)
		.reduce((attrs, attr) => {
			const i = attr.indexOf('=');
			const [key, value] = i > 0 ? [attr.slice(0, i), attr.slice(i + 1)] : [attr];
			const [, unquoted] = (value && value.match(regex_quoted_value)) || [];
			return { ...attrs, [key]: unquoted ?? value ?? true };
		}, {});
}

const regex_style_tags = /<!--[^]*?-->|<style(\s[^]*?)?(?:>([^]*?)<\/style>|\/>)/gi;
const regex_script_tags = /<!--[^]*?-->|<script(\s[^]*?)?(?:>([^]*?)<\/script>|\/>)/gi;

/**
 * Calculate the updates required to process all instances of the specified tag.
 * @param {'style' | 'script'} tag_name
 * @param {import('./public.js').Preprocessor} preprocessor
 * @param {import('./private.js').Source} source
 * @returns {Promise<import('./private.js').SourceUpdate>}
 */
async function process_tag(tag_name, preprocessor, source) {
	const { filename, source: markup } = source;
	const tag_regex = tag_name === 'style' ? regex_style_tags : regex_script_tags;

	/**
	 * @type {string[]}
	 */
	const dependencies = [];

	/**
	 * @param {string} tag_with_content
	 * @param {number} tag_offset
	 * @returns {Promise<MappedCode>}
	 */
	async function process_single_tag(tag_with_content, attributes = '', content = '', tag_offset) {
		const no_change = () =>
			MappedCode.from_source(slice_source(tag_with_content, tag_offset, source));
		if (!attributes && !content) return no_change();
		const processed = await preprocessor({
			content: content || '',
			attributes: parse_tag_attributes(attributes || ''),
			markup,
			filename
		});
		if (!processed) return no_change();
		if (processed.dependencies) dependencies.push(...processed.dependencies);
		if (!processed.map && processed.code === content) return no_change();
		return processed_tag_to_code(
			processed,
			tag_name,
			attributes,
			slice_source(content, tag_offset, source)
		);
	}
	const { string, map } = await replace_in_code(tag_regex, process_single_tag, source);
	return { string, map, dependencies };
}

/**
 * @param {import('./public.js').MarkupPreprocessor} process
 * @param {import('./private.js').Source} source
 */
async function process_markup(process, source) {
	const processed = await process({
		content: source.source,
		filename: source.filename
	});
	if (processed) {
		return {
			string: processed.code,
			map: processed.map
				? // TODO: can we use decode_sourcemap?
				  typeof processed.map === 'string'
					? JSON.parse(processed.map)
					: processed.map
				: undefined,
			dependencies: processed.dependencies
		};
	} else {
		return {};
	}
}

/**
 * @param {string} source
 * @param {import('./public.js').PreprocessorGroup | import('./public.js').PreprocessorGroup[]} preprocessor
 * @param {{ filename?: string }} options
 * @returns {Promise<import('./public.js').Processed>}
 */
export default async function preprocess(source, preprocessor, options) {
	/**
	 * @type {string | undefined}
	 */
	const filename = (options && options.filename) || /** @type {any} */ (preprocessor).filename; // legacy
	const preprocessors = preprocessor
		? Array.isArray(preprocessor)
			? preprocessor
			: [preprocessor]
		: [];
	const markup = preprocessors.map((p) => p.markup).filter(Boolean);
	const script = preprocessors.map((p) => p.script).filter(Boolean);
	const style = preprocessors.map((p) => p.style).filter(Boolean);
	const result = new PreprocessResult(source, filename);
	// TODO keep track: what preprocessor generated what sourcemap?
	// to make debugging easier = detect low-resolution sourcemaps in fn combine_mappings
	for (const process of markup) {
		result.update_source(await process_markup(process, result));
	}
	for (const process of script) {
		result.update_source(await process_tag('script', process, result));
	}
	for (const preprocess of style) {
		result.update_source(await process_tag('style', preprocess, result));
	}
	return result.to_processed();
}