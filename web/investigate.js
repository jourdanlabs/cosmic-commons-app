// Copyright 2026 Leland Jourdan II / C&L Strategy
// SPDX-License-Identifier: Apache-2.0
// Guided application forms only. The unchanged COMMONS engine performs inference,
// adequacy, experiment selection, budget accounting, and expected-loss decisions.
import { el, field, button as actionButton, input as textInput, select, numericInput, renderError } from './ui.js';

const INDEPENDENCE = 'conditionally-independent-given-hypothesis-and-experiment';
const LIMITS = { hypotheses: 100, experiments: 100, outcomes: 100, actions: 100, observations: 5000 };

function put(record, key, value) {
  // Identifier strings are data, including __proto__; never assign them through
  // the object's prototype setter.
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}
function own(record, key, fallback) { return record && Object.hasOwn(record, key) ? record[key] : fallback; }
function nextId(prefix, values) {
  let index = 1;
  while (values.includes(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}
function section(title, help, disabled = false) {
  return el('fieldset', { className: 'form-section', disabled },
    el('legend', {}, title), help ? el('p', { className: 'help' }, help) : null);
}
function identifier(value, values, current, name = 'Identifier') {
  if (!value.trim()) throw new Error(`${name} cannot be empty.`);
  if (value.length > 256) throw new Error(`${name} must fit within 256 characters.`);
  if (value !== current && values.includes(value)) throw new Error(`${name} must be unique. “${value}” already exists.`);
}

/** Render the ordinary investigation editor. No computation is done in the browser. */
export function renderInvestigation(container, { input, onChange, api, onFork }) {
  container.replaceChildren();
  if (input?.kind !== 'discovery' || !input.definition ||
      !Array.isArray(input.definition.hypotheses) || !Array.isArray(input.definition.experiments) ||
      !Array.isArray(input.observations) ||
      input.definition.hypotheses.some(h => !h || typeof h.id !== 'string') ||
      input.definition.experiments.some(e => !e || typeof e.id !== 'string' || !Array.isArray(e.outcomes) || !e.likelihoods) ||
      input.observations.some(o => !o || typeof o.id !== 'string') ||
      (input.actions !== undefined && (!Array.isArray(input.actions) || input.actions.some(a => !a || typeof a.id !== 'string' || !a.losses)))) {
    container.append(renderError('This input is not a supported investigation form. Correct its shape in Advanced JSON; your saved input is retained.'));
    return;
  }

  const draft = structuredClone(input);
  const definition = draft.definition;
  let committedObservations = structuredClone(input.observations);
  let observationRows = [];
  let pendingObservation = null;
  // Removing observations is a recorded revision, not permission to rewrite a
  // model that has already seen them. Such changes still require a fresh fork.
  let frozen = draft.observations.length > 0;
  const modelSections = [];
  const emit = () => onChange(structuredClone(draft));
  const button = (label, callback, className) => actionButton(label, async event => {
    const invalid = container.querySelector('input:invalid, select:invalid, textarea:invalid');
    if (invalid) {
      invalid.reportValidity(); invalid.focus();
      throw new Error('Finish correcting and validating the highlighted field before changing the form. Your draft text is retained.');
    }
    return callback(event);
  }, className);
  const num = (value, callback, label) => numericInput(value, async value => {
    if (frozen) throw new Error('This model is frozen after observations. Fork a fresh investigation before changing it.');
    callback(value);
    await emit();
  }, api, { 'aria-label': label, autocomplete: 'off' });
  const idControl = (value, values, callback, label) => {
    const control = textInput(value, async next => {
      identifier(next, values(), value, label);
      callback(next);
      value = next;
      control.setCustomValidity('');
      await emit();
    }, { 'aria-label': label, maxlength: 256, required: true, spellcheck: 'false', autocomplete: 'off' });
    control.addEventListener('input', () => control.setCustomValidity('Leave this field to validate the new identifier.'));
    return control;
  };
  const freezeModels = () => {
    if (draft.observations.length) frozen = true;
    for (const node of modelSections) node.disabled = frozen;
    lockNotice.hidden = !frozen;
    updateObservationAvailability();
  };

  container.append(el('div', { className: 'record-card' },
    el('h3', {}, 'Declare the model. Record what happened.'),
    el('p', { className: 'help' }, 'COMMONS updates probabilities within the candidate family you supply. It does not discover arbitrary explanations, prove the true explanation is included, or certify a prediction was committed before an observation.'),
    el('p', { className: 'help' }, 'Numeric values are checked by the server when you leave a field. Priors and likelihood rows are never automatically normalized. Run the saved case to see the engine’s validation and result.')));

  const forkButton = button('Fork a fresh investigation', async () => {
    if (typeof onFork !== 'function') throw new Error('Forking is unavailable. Reopen the case and try again.');
    const fresh = structuredClone(draft);
    fresh.observations = [];
    // The application fork service records provenance and assigns a fresh epoch.
    await onFork(fresh);
  });
  const lockNotice = el('div', { className: 'record-card', hidden: !frozen },
    el('strong', {}, 'Model frozen after observations'),
    el('p', { className: 'help' }, 'Model, priors, experiments, budget, adequacy and actions stay fixed in this case. Saved observations are an immutable prefix: append new observations here, but fork to correct a saved observation or change its order. The original investigation and its history are preserved, and the new case starts with zero observations and a fresh epoch. Re-enter corrected historical observations explicitly; a fork does not establish a prior real-world prediction.'), forkButton);
  container.append(lockNotice);

  const basics = section('Model and budget', 'Costs, budget and losses use units you declare consistently; COMMONS does not infer a currency or measurement unit.', frozen);
  modelSections.push(basics);
  const modelId = idControl(definition.modelId ?? '', () => [], value => { definition.modelId = value; }, 'Model ID');
  const assumption = el('input', { type: 'checkbox', checked: definition.observationAssumption === INDEPENDENCE,
    onchange: async event => {
      if (event.target.checked) definition.observationAssumption = INDEPENDENCE;
      else delete definition.observationAssumption;
      updateObservationAvailability();
      await emit();
    } });
  basics.append(el('div', { className: 'form-grid' },
    field('Model ID', modelId, 'Names the declared model version.'),
    field('Total budget', num(definition.budget, value => { definition.budget = value; }, 'Total budget'), 'Nonnegative. Each recorded observation spends its experiment’s cost.')),
    field('Observation assumption', assumption, 'I explicitly assume observations are conditionally independent given the hypothesis and experiment. Required for this engine.'));

  function optionalNumber(key, label, defaultValue, help) {
    const controls = el('div', { className: 'form-row' });
    const setting = el('input', { type: 'checkbox', checked: definition[key] !== undefined });
    const editor = num(definition[key] ?? defaultValue, value => { if (setting.checked) definition[key] = value; }, label);
    editor.hidden = definition[key] === undefined;
    editor.querySelector('input').disabled = definition[key] === undefined;
    setting.addEventListener('change', async () => {
      editor.hidden = !setting.checked;
      editor.querySelector('input').disabled = !setting.checked;
      controls.querySelector('.action-error')?.remove();
      if (!setting.checked) {
        delete definition[key];
        await emit();
        return;
      }
      const control = editor.querySelector('input');
      control.setCustomValidity('Waiting for number validation.');
      try {
        const response = await api('/api/value', { type: 'number', text: control.value });
        if (!setting.checked) return;
        if (frozen) throw new Error('The model is now frozen. Fork a fresh investigation before changing this setting.');
        definition[key] = response.value;
        control.setCustomValidity('');
        await emit();
      } catch (error) {
        control.setCustomValidity(error.message);
        const message = renderError(error); message.classList.add('action-error'); controls.append(message);
      }
    });
    controls.append(field(label, setting, help), editor);
    return controls;
  }
  basics.append(optionalNumber('stopProbability', 'Use posterior stopping threshold', 0.95,
    'Optional threshold greater than 0.5 and at most 1; a stopping policy, not a calibration guarantee.'),
    optionalNumber('minInformationGainNats', 'Use minimum information gain', 0.001,
      'Optional nonnegative threshold in nats for experiment selection.'));
  container.append(basics);

  const hypothesesSection = section('Candidate hypotheses', 'At least two hypotheses. Priors must lie between 0 and 1 and sum to 1. A zero prior excludes a candidate from posterior support and the adequacy family.', frozen);
  const hypothesesBody = el('div');
  hypothesesSection.append(hypothesesBody);
  modelSections.push(hypothesesSection);
  container.append(hypothesesSection);

  const experimentsSection = section('Experiments and likelihoods', 'Each cell is P(outcome | hypothesis, experiment). Outcomes are mutually exclusive; every hypothesis row must sum to 1. These probabilities are declared assumptions, not fitted or verified by the form.', frozen);
  const experimentsBody = el('div');
  experimentsSection.append(experimentsBody);
  modelSections.push(experimentsSection);
  container.append(experimentsSection);

  const adequacySection = section('Family adequacy', 'The public monitor supports exactly two declared outcome labels per experiment and the frozen positive-prior family. NOT_REJECTED means insufficient evidence against that family; it does not approve the model or authorize an action.', frozen);
  const adequacyBody = el('div');
  adequacySection.append(adequacyBody);
  modelSections.push(adequacySection);
  container.append(adequacySection);

  const actionsSection = section('Optional actions and losses', 'Enter a loss for every action / hypothesis pair in a consistent unit. Expected-loss suggestions are conditional on your model and supplied losses. They are not policy ALLOW or an executed action.', frozen);
  const actionsBody = el('div');
  actionsSection.append(actionsBody);
  modelSections.push(actionsSection);
  container.append(actionsSection);

  const observationsSection = section('Ordered observations', 'Entries below are user-reported historical observations. Their array order is the engine sequence. Once saved, their prefix is read-only; only new unsaved entries may be edited, removed or reordered. Recording or replaying them does not establish when a real-world prediction was committed.');
  const observationsBody = el('div');
  const observationComposer = el('div', { className: 'record-card' });
  const correctionNotice = el('div', { className: 'record-card', role: 'alert', tabindex: '-1', hidden: true },
    el('strong', {}, 'A saved observation differs from this unsaved draft'),
    el('p', { className: 'help' }, 'An observation was committed while you were editing. Your subsequent draft text is retained, but the saved prefix cannot be changed in this case. Fork a fresh investigation and re-enter the correction as historical context, or explicitly return to the saved prefix below. The original record remains preserved.'));
  const keepSaved = actionButton('Keep the saved observation prefix', async () => {
    const tail = draft.observations.slice(committedObservations.length);
    draft.observations = [...structuredClone(committedObservations), ...tail];
    drawObservations();
    await emit();
  });
  correctionNotice.append(keepSaved);
  const observationAvailability = el('p', { className: 'help', role: 'status' });
  const addObservation = button('Add observation', async () => {
    if (!savedPrefixMatches()) throw new Error('Resolve the saved observation correction before appending another observation.');
    if (definition.observationAssumption !== INDEPENDENCE) throw new Error('Acknowledge conditional independence before recording observations.');
    if (draft.observations.length >= LIMITS.observations) throw new Error('At most 5000 observations are supported, subject to the engine receipt-size limit.');
    const experiment = definition.experiments.find(e => e.id === pendingObservation?.experimentId && e.outcomes.length > 0);
    if (!experiment) throw new Error('Declare an experiment and its outcomes before adding observations.');
    identifier(pendingObservation.id, draft.observations.map(o => o.id), undefined, 'Observation ID');
    if (!experiment.outcomes.includes(pendingObservation.outcome)) throw new Error('Choose one of the selected experiment’s declared outcomes.');
    draft.observations.push({ ...pendingObservation });
    pendingObservation = null;
    freezeModels();
    drawObservations();
    await emit();
  });
  observationsSection.append(correctionNotice, observationsBody, observationComposer, observationAvailability, addObservation);
  container.append(observationsSection);

  function updateObservationAvailability() {
    const acknowledged = definition.observationAssumption === INDEPENDENCE;
    const hasExperiment = definition.experiments.some(e => e.outcomes.length > 0);
    addObservation.disabled = !savedPrefixMatches() || !acknowledged || !hasExperiment || draft.observations.length >= LIMITS.observations;
    observationAvailability.textContent = !acknowledged
      ? 'Acknowledge the observation assumption above before adding observations.'
      : !hasExperiment ? 'Add an experiment with outcomes before recording observations.'
        : `${committedObservations.length} saved observations are read-only. Append observations in the order they occurred. Arrow controls only reorder the new unsaved tail; fork to correct saved observations.`;
  }

  function savedPrefixMatches() {
    // The storage boundary canonicalizes object keys. Observation semantics are
    // these three explicit values in array order, not object insertion order.
    return committedObservations.every((observation, index) => {
      const current = draft.observations[index];
      return current?.id === observation.id && current?.experimentId === observation.experimentId && current?.outcome === observation.outcome;
    });
  }

  function assertObservationEditable(index) {
    if (index < committedObservations.length) throw new Error('This observation is already saved. Fork a fresh investigation to correct it; the original record is preserved.');
    if (!savedPrefixMatches()) throw new Error('Resolve the saved observation correction first. Your draft is retained.');
  }

  function lockSavedObservationRows() {
    for (const row of observationRows) {
      const saved = row.index < committedObservations.length;
      row.node.disabled = saved;
      row.title.textContent = `Observation ${row.index + 1} · ${saved ? 'saved · read-only' : 'new unsaved entry'}`;
      row.moveUp.disabled = saved || row.index <= committedObservations.length;
      row.moveDown.disabled = saved || row.index === draft.observations.length - 1;
      row.remove.disabled = saved;
    }
    correctionNotice.hidden = savedPrefixMatches();
    updateObservationAvailability();
  }

  function drawObservationComposer() {
    observationComposer.replaceChildren();
    const available = definition.experiments.filter(e => e.outcomes.length > 0);
    if (!available.length) { observationComposer.append(el('p', { className: 'help' }, 'Declare an experiment with outcomes to prepare an observation.')); return; }
    if (!pendingObservation || !available.some(e => e.id === pendingObservation.experimentId)) {
      const experiment = available[0];
      pendingObservation = { id: nextId('observation', draft.observations.map(o => o.id)), experimentId: experiment.id, outcome: experiment.outcomes[0] };
    }
    const experiment = available.find(e => e.id === pendingObservation.experimentId);
    if (!experiment.outcomes.includes(pendingObservation.outcome)) pendingObservation.outcome = experiment.outcomes[0];
    const id = textInput(pendingObservation.id, value => {
      identifier(value, draft.observations.map(o => o.id), undefined, 'Observation ID');
      pendingObservation.id = value;
      id.setCustomValidity('');
    }, { 'aria-label': 'New observation ID', required: true, maxlength: 256, autocomplete: 'off' });
    id.addEventListener('input', () => id.setCustomValidity('Leave this field to validate the observation identifier.'));
    const experimentControl = select(pendingObservation.experimentId, available.map(e => e.id), value => {
      pendingObservation.experimentId = value;
      drawObservationComposer();
    });
    experimentControl.setAttribute('aria-label', 'New observation experiment');
    const outcomeControl = select(pendingObservation.outcome, experiment.outcomes, value => { pendingObservation.outcome = value; });
    outcomeControl.setAttribute('aria-label', 'New observed outcome');
    observationComposer.append(el('h4', {}, 'Prepare a new observation'),
      el('div', { className: 'form-grid' }, field('New observation ID', id), field('Experiment', experimentControl), field('Observed outcome', outcomeControl)),
      el('p', { className: 'help' }, 'Choose the actual experiment and outcome first. Add observation records and saves this entry; once saved, corrections require a fresh fork. Preparing these fields alone does not change the case.'));
  }

  function drawHypotheses() {
    hypothesesBody.replaceChildren();
    for (const hypothesis of definition.hypotheses) {
      const excluded = el('p', { className: 'help', role: 'status' }, hypothesis.prior === 0 ? 'Zero prior — excluded from posterior support and adequacy.' : 'Included when prior is strictly positive.');
      const id = idControl(hypothesis.id, () => definition.hypotheses.map(h => h.id), next => {
        const previous = hypothesis.id;
        hypothesis.id = next;
        for (const experiment of definition.experiments) {
          const row = own(experiment.likelihoods, previous, {});
          delete experiment.likelihoods[previous];
          put(experiment.likelihoods, next, row);
        }
        for (const action of draft.actions ?? []) {
          const loss = own(action.losses, previous, 0);
          delete action.losses[previous];
          put(action.losses, next, loss);
        }
        drawExperiments(); drawActions();
      }, 'Hypothesis ID');
      const prior = num(hypothesis.prior, value => {
        hypothesis.prior = value;
        excluded.textContent = value === 0 ? 'Zero prior — excluded from posterior support and adequacy.' : 'Included when prior is strictly positive; invalid probabilities are refused by the engine.';
      }, `Prior for ${hypothesis.id}`);
      hypothesesBody.append(el('div', { className: 'record-card' },
        el('div', { className: 'form-grid' }, field('Hypothesis ID', id), field('Declared prior', prior)), excluded,
        button('Remove hypothesis', async () => {
          if (definition.hypotheses.length <= 2) throw new Error('Keep at least two hypotheses.');
          definition.hypotheses.splice(definition.hypotheses.indexOf(hypothesis), 1);
          for (const experiment of definition.experiments) delete experiment.likelihoods[hypothesis.id];
          for (const action of draft.actions ?? []) delete action.losses[hypothesis.id];
          drawHypotheses(); drawExperiments(); drawActions();
          await emit();
        }, 'danger-button')));
    }
    hypothesesBody.append(button('Add hypothesis', async () => {
      if (definition.hypotheses.length >= LIMITS.hypotheses) throw new Error('At most 100 hypotheses are supported.');
      const id = nextId('hypothesis', definition.hypotheses.map(h => h.id));
      definition.hypotheses.push({ id, prior: 0 });
      for (const experiment of definition.experiments) put(experiment.likelihoods, id, Object.fromEntries(experiment.outcomes.map(outcome => [outcome, 0])));
      for (const action of draft.actions ?? []) put(action.losses, id, 0);
      drawHypotheses(); drawExperiments(); drawActions();
      await emit();
    }), el('p', { className: 'help' }, 'A new candidate starts with prior 0 and likelihoods 0. Enter its declared row probabilities explicitly; existing values are retained.'));
  }

  function drawExperiments() {
    experimentsBody.replaceChildren();
    for (const experiment of definition.experiments) {
      const experimentCard = el('div', { className: 'record-card' });
      const id = idControl(experiment.id, () => definition.experiments.map(e => e.id), next => {
        experiment.id = next;
        drawObservations();
      }, 'Experiment ID');
      experimentCard.append(el('div', { className: 'form-grid' }, field('Experiment ID', id), field('Cost per observation', num(experiment.cost, value => { experiment.cost = value; }, `Cost for ${experiment.id}`), 'Must be strictly positive.')));

      const outcomes = el('div', { className: 'form-grid' });
      for (let index = 0; index < experiment.outcomes.length; index += 1) {
        const value = experiment.outcomes[index];
        const label = idControl(value, () => experiment.outcomes, next => {
          experiment.outcomes[index] = next;
          for (const hypothesis of definition.hypotheses) {
            const row = own(experiment.likelihoods, hypothesis.id, {});
            const probability = own(row, value, 0);
            delete row[value]; put(row, next, probability); put(experiment.likelihoods, hypothesis.id, row);
          }
          drawExperiments(); drawObservations(); drawAdequacy();
        }, 'Outcome label');
        outcomes.append(el('div', { className: 'record-card' }, field(`Outcome ${index + 1}`, label),
          button('Remove outcome', async () => {
            if (experiment.outcomes.length <= 2) throw new Error('Each experiment needs at least two outcomes.');
            const outcome = experiment.outcomes[index];
            experiment.outcomes.splice(index, 1);
            for (const hypothesis of definition.hypotheses) delete own(experiment.likelihoods, hypothesis.id, {})[outcome];
            drawExperiments(); drawAdequacy(); drawObservations();
            await emit();
          }, 'danger-button')));
      }
      experimentCard.append(outcomes, button('Add outcome', async () => {
        if (experiment.outcomes.length >= LIMITS.outcomes) throw new Error('At most 100 outcomes per experiment are supported.');
        const outcome = nextId('outcome', experiment.outcomes);
        experiment.outcomes.push(outcome);
        for (const hypothesis of definition.hypotheses) {
          const row = own(experiment.likelihoods, hypothesis.id, {});
          put(row, outcome, 0); put(experiment.likelihoods, hypothesis.id, row);
        }
        drawExperiments(); drawAdequacy(); drawObservations();
        await emit();
      }), el('p', { className: 'help' }, 'New outcome probabilities start at 0. Removing outcomes retains remaining values; edit the row explicitly if it no longer sums to 1.'));

      const table = el('table', { className: 'data-table' },
        el('caption', {}, `Declared likelihoods for ${experiment.id}: P(outcome | hypothesis)`),
        el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Hypothesis'), experiment.outcomes.map(outcome => el('th', { scope: 'col' }, outcome)))));
      const body = el('tbody');
      for (const hypothesis of definition.hypotheses) {
        const row = el('tr', {}, el('th', { scope: 'row' }, hypothesis.id));
        for (const outcome of experiment.outcomes) {
          row.append(el('td', {}, num(own(own(experiment.likelihoods, hypothesis.id, {}), outcome, ''), value => {
            if (!Object.hasOwn(experiment.likelihoods, hypothesis.id)) put(experiment.likelihoods, hypothesis.id, {});
            put(experiment.likelihoods[hypothesis.id], outcome, value);
          }, `Likelihood of ${outcome} given ${hypothesis.id} in ${experiment.id}`)));
        }
        body.append(row);
      }
      table.append(body);
      experimentCard.append(el('div', { className: 'table-wrap' }, table), button('Remove experiment', async () => {
        if (definition.experiments.length <= 1) throw new Error('Keep at least one experiment.');
        definition.experiments.splice(definition.experiments.indexOf(experiment), 1);
        drawExperiments(); drawAdequacy(); drawObservations(); updateObservationAvailability();
        await emit();
      }, 'danger-button'));
      experimentsBody.append(experimentCard);
    }
    experimentsBody.append(button('Add experiment', async () => {
      if (definition.experiments.length >= LIMITS.experiments) throw new Error('At most 100 experiments are supported.');
      const id = nextId('experiment', definition.experiments.map(e => e.id));
      definition.experiments.push({ id, cost: 1, outcomes: ['1', '0'], likelihoods: Object.fromEntries(definition.hypotheses.map(h => [h.id, { '1': 0.5, '0': 0.5 }])) });
      drawExperiments(); drawAdequacy(); updateObservationAvailability();
      await emit();
    }), el('p', { className: 'help' }, 'A new experiment starts with two outcomes, cost 1, and explicitly displayed 0.5 / 0.5 likelihood rows. Replace these starter assumptions with your own.'));
  }

  function drawAdequacy() {
    adequacyBody.replaceChildren();
    const enabled = el('input', { type: 'checkbox', checked: draft.adequacy !== undefined, onchange: async event => {
      if (event.target.checked) draft.adequacy = { alpha: 0.05, epochId: `epoch-${crypto.randomUUID()}` };
      else delete draft.adequacy;
      drawAdequacy(); await emit();
    } });
    adequacyBody.append(field('Enable binary-family adequacy monitor', enabled, 'Absent or unsupported adequacy defers integrated action suggestions.'));
    if (draft.adequacy) {
      adequacyBody.append(el('div', { className: 'form-grid' },
        field('Alpha', num(draft.adequacy.alpha, value => { draft.adequacy.alpha = value; }, 'Adequacy alpha'), 'Strictly between 0 and 1.'),
        field('Epoch ID', idControl(draft.adequacy.epochId ?? '', () => [], value => { draft.adequacy.epochId = value; }, 'Adequacy epoch ID'), 'Declare before observing data. A fresh fork receives a fresh epoch.')));
      const nonBinary = definition.experiments.filter(e => e.outcomes.length !== 2).map(e => e.id);
      if (nonBinary.length) adequacyBody.append(el('p', { className: 'help' }, `Unsupported adequacy scope: ${nonBinary.join(', ')} has other than two outcomes. The engine will DEFER; the form does not change your outcomes.`));
    }
  }

  function drawActions() {
    actionsBody.replaceChildren();
    const enabled = el('input', { type: 'checkbox', checked: draft.actions !== undefined, onchange: async event => {
      if (event.target.checked) draft.actions = [];
      else delete draft.actions;
      drawActions(); await emit();
    } });
    actionsBody.append(field('Include declared actions', enabled, 'This only requests a suggestion. No external action is taken.'));
    if (draft.actions === undefined) return;
    for (const action of draft.actions) {
      const card = el('div', { className: 'record-card' }, field('Action ID', idControl(action.id, () => draft.actions.map(a => a.id), value => { action.id = value; }, 'Action ID')));
      const grid = el('div', { className: 'form-grid' });
      for (const hypothesis of definition.hypotheses) grid.append(field(`Loss if ${hypothesis.id}`, num(own(action.losses, hypothesis.id, ''), value => { put(action.losses, hypothesis.id, value); }, `Loss for ${action.id} under ${hypothesis.id}`)));
      card.append(grid, button('Remove action', async () => {
        draft.actions.splice(draft.actions.indexOf(action), 1);
        drawActions(); await emit();
      }, 'danger-button'));
      actionsBody.append(card);
    }
    actionsBody.append(button('Add action', async () => {
      if (draft.actions.length >= LIMITS.actions) throw new Error('At most 100 actions are supported.');
      draft.actions.push({ id: nextId('action', draft.actions.map(a => a.id)), losses: Object.fromEntries(definition.hypotheses.map(h => [h.id, 0])) });
      drawActions(); await emit();
    }), el('p', { className: 'help' }, 'New action losses start at 0. Enter every loss explicitly in the same unit before using a suggestion.'));
  }

  function drawObservations() {
    observationsBody.replaceChildren();
    observationRows = [];
    if (!draft.observations.length) observationsBody.append(el('p', { className: 'muted' }, 'No observations recorded. Set your model and monitor before starting.'));
    for (let index = 0; index < draft.observations.length; index += 1) {
      const observation = draft.observations[index];
      const experimentChoices = definition.experiments.map(e => ({ value: e.id, label: e.id }));
      if (!definition.experiments.some(e => e.id === observation.experimentId)) experimentChoices.unshift({ value: observation.experimentId, label: `${observation.experimentId} — undeclared experiment` });
      const selectedExperiment = definition.experiments.find(e => e.id === observation.experimentId);
      const outcomeChoices = (selectedExperiment?.outcomes ?? []).map(value => ({ value, label: value }));
      if (!selectedExperiment?.outcomes.includes(observation.outcome)) outcomeChoices.unshift({ value: observation.outcome, label: `${observation.outcome} — undeclared outcome` });
      const experimentControl = select(observation.experimentId, experimentChoices, async value => {
        assertObservationEditable(index);
        observation.experimentId = value;
        const experiment = definition.experiments.find(e => e.id === value);
        if (experiment && !experiment.outcomes.includes(observation.outcome)) observation.outcome = experiment.outcomes[0];
        drawObservations(); await emit();
      });
      experimentControl.setAttribute('aria-label', `Experiment for observation ${index + 1}`);
      const outcomeControl = select(observation.outcome, outcomeChoices, async value => { assertObservationEditable(index); observation.outcome = value; await emit(); });
      outcomeControl.setAttribute('aria-label', `Outcome for observation ${index + 1}`);
      const moveUp = button('Move earlier', async () => {
        assertObservationEditable(index);
        if (index <= committedObservations.length) throw new Error('New observations cannot move ahead of the saved prefix.');
        [draft.observations[index - 1], draft.observations[index]] = [draft.observations[index], draft.observations[index - 1]];
        drawObservations(); await emit();
      });
      moveUp.disabled = index === 0;
      const moveDown = button('Move later', async () => {
        assertObservationEditable(index);
        [draft.observations[index], draft.observations[index + 1]] = [draft.observations[index + 1], draft.observations[index]];
        drawObservations(); await emit();
      });
      moveDown.disabled = index === draft.observations.length - 1;
      const remove = button('Remove observation', async () => {
        assertObservationEditable(index);
        draft.observations.splice(draft.observations.indexOf(observation), 1);
        drawObservations(); updateObservationAvailability(); await emit();
      }, 'danger-button');
      const title = el('legend', {}, `Observation ${index + 1} · recorded sequence`);
      const node = el('fieldset', { className: 'record-card' }, title,
        el('div', { className: 'form-grid' },
          field('Observation ID', idControl(observation.id, () => draft.observations.map(o => o.id), value => { assertObservationEditable(index); observation.id = value; }, 'Observation ID')),
          field('Experiment', experimentControl), field('Observed outcome', outcomeControl)),
        el('div', { className: 'form-row' }, moveUp, moveDown, remove));
      observationRows.push({ node, title, moveUp, moveDown, remove, index });
      observationsBody.append(node);
    }
    lockSavedObservationRows();
    drawObservationComposer();
  }

  drawHypotheses(); drawExperiments(); drawAdequacy(); drawActions(); drawObservations(); freezeModels();
  return {
    getInput: () => structuredClone(draft),
    markSaved: savedInput => {
      if (savedInput?.kind !== 'discovery' || !Array.isArray(savedInput.observations)) return;
      // Update controls in place: do not replace focused elements or discard
      // raw invalid text merely because an autosave response arrived.
      committedObservations = structuredClone(savedInput.observations);
      if (committedObservations.length) frozen = true;
      freezeModels();
      lockSavedObservationRows();
    },
    validate: () => {
      if (!savedPrefixMatches()) { correctionNotice.hidden = false; correctionNotice.focus(); return false; }
      const invalid = container.querySelector('input:invalid, select:invalid, textarea:invalid');
      if (invalid) { invalid.reportValidity(); invalid.focus(); return false; }
      return true;
    },
  };
}
