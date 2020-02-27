import * as React from 'react';
import { useState, useEffect, useCallback } from 'react';

// eslint-disable-next-line no-unused-vars
import TinyMCE, { editorStateToHtml, OnChangeEvent } from './TinyMCE';
import { connect } from 'react-redux';
import AsyncActionQueue from '../lib/AsyncActionQueue';
import MultiNoteActions from './MultiNoteActions';

// eslint-disable-next-line no-unused-vars
import { EditorState } from './utils/NoteText';
const { themeStyle, buildStyle } = require('../theme.js');
const markupLanguageUtils = require('lib/markupLanguageUtils');
const Setting = require('lib/models/Setting');
const { MarkupToHtml } = require('lib/joplin-renderer');
const HtmlToMd = require('lib/HtmlToMd');
const { _ } = require('lib/locale');
const Note = require('lib/models/Note.js');
const Resource = require('lib/models/Resource.js');
const { shim } = require('lib/shim');
const { bridge } = require('electron').remote.require('./bridge');

// Note: Data from the editor is currently processed and saved this way:
//
// 1. TinyMCE triggers the onChange event if the user stops typing for 500ms
// 2. NoteText2 receives this event, update formNote and schedule a save operation
// 3. The note is saved after several ms depending on how AsyncActionQueue is configured
//
// This means that if the user types something, then switch to another note within
// less than 500ms, the changes will be lost. It's relatively rare case but it could happen.
//
// The delay between scheduling save and actual saving on the other hand is not an issue
// because when scheduling the complete state is saved to a variable, which is then
// used to save to the database. So even if the component is unmounted, saving will
// still happen in the background.
//
// New notes don't have an ID and can be more of a problem, this is why they are saved
// immediately (no scheduling) once the user starts modifying it so that we have an ID
// to work with.

// TODO: preserve image size
// TODO: handle HTML notes
// TODO: handle switching layout when note hasn't saved yet
// TODO: add indicator showing that note has been saved or not
//       from TinyMCE, emit willChange event, which means we know we're expecting changes
//
// TODO: create new note, type something in body => cursor jumps back at beginning

interface NoteTextProps {
	style: any,
	noteId: string,
	theme: number,
	newNote: any,
	dispatch: Function,
	selectedNoteIds: string[],
	notes:any[],
	watchedNoteFiles:string[],
}

interface FormNote {
	id: string,
	title: string,
	parent_id: string,
	is_todo: number,
	bodyEditorState?: EditorState,
	fromNewNote: any,
}

const defaultNote = ():FormNote => {
	return {
		id: '',
		parent_id: '',
		title: '',
		is_todo: 0,
		fromNewNote: null,
	};
};

function styles_(props:NoteTextProps) {
	return buildStyle('NoteText', props.theme, (theme:any) => {
		return {
			titleInput: {
				flex: 1,
				display: 'inline-block',
				paddingTop: 5,
				paddingBottom: 5,
				paddingLeft: 8,
				paddingRight: 8,
				marginRight: theme.paddingLeft,
				color: theme.textStyle.color,
				fontSize: theme.textStyle.fontSize * 1.25 *1.5,
				backgroundColor: theme.backgroundColor,
				border: '1px solid',
				borderColor: theme.dividerColor,
			},
			warningBanner: {
				background: theme.warningBackgroundColor,
				fontFamily: theme.fontFamily,
				padding: 10,
				fontSize: theme.fontSize,
			},
			tinyMCE: {
				width: '100%',
				height: '100%',
			},
		};
	});
}

const saveNoteActionQueue = new AsyncActionQueue(1000);

function NoteText2(props:NoteTextProps) {
	const [formNote, setFormNote] = useState<FormNote>(defaultNote());
	const [defaultEditorState, setDefaultEditorState] = useState<EditorState>({});

	console.info('props.noteId', props.noteId);
	console.info('props.newNote', props.newNote);

	const styles = styles_(props);

	const htmlToMarkdown = useCallback(async (html:string):Promise<string> => {
		const htmlToMd = new HtmlToMd();
		let md = htmlToMd.parse(html);
		md = await Note.replaceResourceExternalToInternalLinks(md, { useAbsolutePaths: true });
		return md;
	}, []);

	const formNoteToNote = async (formNote:FormNote):Promise<any> => {
		const newNote:any = Object.assign({}, formNote);

		if ('bodyEditorState' in formNote) {
			const html = await editorStateToHtml(formNote.bodyEditorState);
			newNote.body = await htmlToMarkdown(html);
		}

		delete newNote.bodyEditorState;
		delete newNote.fromNewNote;

		return newNote;
	};

	const saveNoteNow = useCallback(async (fn:FormNote = null) => {
		scheduleSaveNote(fn ? fn : formNote);
		return saveNoteActionQueue.waitForAllDone();
	}, [formNote]);

	const scheduleSaveNote = (formNote:FormNote) => {
		console.info('Scheduling...', formNote);

		const makeAction = (formNote:FormNote) => {
			return async function() {
				const note = await formNoteToNote(formNote);
				console.info('Saving note...', note);
				const result = await Note.save(note);
				if (!formNote.id) {
					setFormNote(Object.assign({}, formNote, { id: result.id }));

					props.dispatch({
						type: 'NOTE_SELECT',
						id: result.id,
					});
				}
			};
		};

		saveNoteActionQueue.push(makeAction(formNote));
	};

	const markdownToHtml = useCallback(async (md:string, options:any = null):Promise<any> => {
		const theme = themeStyle(props.theme);

		// console.info('===================================');
		// console.info('Markdown', md);

		md = await Note.replaceResourceInternalToExternalLinks(md, { useAbsolutePaths: true });

		const markupToHtml = markupLanguageUtils.newMarkupToHtml({
			resourceBaseUrl: `file://${Setting.value('resourceDir')}/`,
		});

		const result = await markupToHtml.render(MarkupToHtml.MARKUP_LANGUAGE_MARKDOWN, md, theme, Object.assign({}, {
			codeTheme: theme.codeThemeCss,
			// userCss: this.props.customCss ? this.props.customCss : '',
			// resources: await shared.attachedResources(noteBody),
			resources: [],
			postMessageSyntax: 'ipcProxySendToHost',
			splitted: true,
			externalAssetsOnly: true,
		}, options));

		// console.info('RESULT', result);
		// console.info('===================================');

		return result;
	}, [props.theme]);

	useEffect(() => {
		if (!props.noteId) return () => {};

		let cancelled = false;

		async function fetchNote() {
			console.info('Load existing', props.noteId);
			const n = await Note.load(props.noteId);
			if (cancelled) return;

			if (!n) throw new Error(`Cannot find note with ID: ${props.noteId}`);

			setFormNote({
				id: n.id,
				title: n.title,
				is_todo: n.is_todo,
				parent_id: n.parent_id,
				fromNewNote: null,
			});

			setDefaultEditorState({ markdown: n.body });
		}

		fetchNote();

		return () => {
			cancelled = true;
		};
	}, [props.noteId]);

	useEffect(() => {
		if (!props.newNote) return;

		console.info('Create new');

		setFormNote({
			id: null,
			parent_id: props.newNote.parent_id,
			is_todo: props.newNote.is_todo,
			title: '',
			fromNewNote: props.newNote,
		});

		setDefaultEditorState({ markdown: '' });

		// TODO: if (note.template) note.body = TemplateUtils.render(note.template);
	}, [props.newNote]);

	const attachResources = useCallback(async () => {
		const filePaths = bridge().showOpenDialog({
			properties: ['openFile', 'createDirectory', 'multiSelections'],
		});
		if (!filePaths || !filePaths.length) return [];

		await saveNoteNow();

		const output = [];

		for (const filePath of filePaths) {
			try {
				const resource = await shim.createResourceFromPath(filePath);
				output.push({
					item: resource,
					markdownTag: Resource.markdownTag(resource),
				});
			} catch (error) {
				bridge().showErrorMessageBox(error.message);
			}
		}

		return output;
	}, [formNote]);

	const onFieldChange = useCallback((field:string, value:any) => {
		const change = field === 'body' ? {
			bodyEditorState: value,
		} : {
			title: value,
		};

		const newNote = Object.assign({}, formNote, change);

		setFormNote(newNote);

		if (!newNote.id) {
			saveNoteNow(newNote);
		} else {
			scheduleSaveNote(newNote);
		}
	}, [formNote]);

	const onBodyChange = (event:OnChangeEvent) => onFieldChange('body', event.editorState.content);

	const onTitleChange = (event:any) => onFieldChange('title', event.target.value);

	if (props.selectedNoteIds.length > 1) {
		return <MultiNoteActions
			theme={props.theme}
			selectedNoteIds={props.selectedNoteIds}
			notes={props.notes}
			dispatch={props.dispatch}
			watchedNoteFiles={props.watchedNoteFiles}
			style={props.style}
		/>;
	}

	return (
		<div style={props.style}>
			<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
				<div style={styles.warningBanner}>
					This is an experimental WYSIWYG editor for evaluation only. Please do not use with important notes as you may lose some data! See the <a href="https://www.patreon.com/posts/34246624">introduction post</a> for more information.
				</div>
				<div style={{ display: 'flex' }}>
					<input
						type="text"
						placeholder={props.newNote ? _('Creating new %s...', formNote.is_todo ? _('to-do') : _('note')) : ''}
						style={styles.titleInput}
						onChange={onTitleChange}
						value={formNote.title}
					/>
				</div>
				<div style={{ display: 'flex', flex: 1 }}>
					<TinyMCE
						style={styles.tinyMCE}
						onChange={onBodyChange}
						defaultEditorState={defaultEditorState}
						markdownToHtml={markdownToHtml}
						attachResources={attachResources}
					/>
				</div>
			</div>
		</div>

	);
}

const mapStateToProps = (state:any) => {
	return {
		noteId: state.selectedNoteIds.length === 1 ? state.selectedNoteIds[0] : null,
		notes: state.notes,
		selectedNoteIds: state.selectedNoteIds,
		// selectedNoteHash: state.selectedNoteHash,
		// noteTags: state.selectedNoteTags,
		// folderId: state.selectedFolderId,
		// itemType: state.selectedItemType,
		// folders: state.folders,
		theme: state.settings.theme,
		// syncStarted: state.syncStarted,
		newNote: state.newNote,
		// windowCommand: state.windowCommand,
		// notesParentType: state.notesParentType,
		// searches: state.searches,
		// selectedSearchId: state.selectedSearchId,
		watchedNoteFiles: state.watchedNoteFiles,
		// customCss: state.customCss,
		// lastEditorScrollPercents: state.lastEditorScrollPercents,
		// historyNotes: state.historyNotes,
		// templates: state.templates,
	};
};

export default connect(mapStateToProps)(NoteText2);