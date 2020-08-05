import ono from '@jsdevtools/ono'
import * as Logger from '@nexus/logger'
import * as Lo from 'lodash'
import { inspect } from 'util'
import { IsRecord, PlainObject } from '../utils'
import { DataDefault, Spec } from './static'

const log = Logger.log.child('settings')

/**
 * todo
 */
export type Metadata<Data extends PlainObject> = {
  [Key in keyof Data]: IsRecord<Data[Key]> extends true // @ts-ignore-error
    ? Record<string, Metadata<Data[string]>>
    : Data[Key] extends PlainObject
    ? {
        fields: Metadata<Data[Key]>
      }
    : {
        value: Data[Key]
        initial: Data[Key]
        from: 'set' | 'initial'
      }
}

/**
 * todo
 */
export type Manager<Input extends PlainObject, Data extends PlainObject> = {
  reset(): Manager<Input, Data>
  change(input: Input): Manager<Input, Data>
  original(): Data
  metadata: Metadata<Data>
  data: Data
}

// todo errors currently report names of setting fields, but not the namespaces
// to it (if any)
// todo should onFixup be replaced with a batch version of onfixups that gets
// called with all fixups that happened for all of the input?
// todo allow env vars to populate settings
// todo track env var as value source
// todo $initial magic var to reset settting to its original state, re-running
// dynamic initializers if necessary
// todo run initial through fixup in dev to be safer
// todo run initial through validation in dev to be safer

export type FixupInfo = {
  name: string
  before: unknown
  after: unknown
  messages: string[]
}

export type Options = {
  /**
   * Handle fixup events.
   *
   * If your settings spec has no fixups then you can ignore this option.
   *
   * By default, fixups are logged at warning level. If you provide your own
   * function then this default behaviour will be disabled. You can retain it by
   * calling the default function passed as a second argument to your function.
   */
  onFixup?: (info: FixupInfo, originalHandler: (info: FixupInfo) => void) => void
  // todo guess we cannot use this because we need thrown error to change
  // control flow.
  // export type ViolationInfo = { name: string; messages: string[] }
  // /**
  //  * Get called back when a validator fails.
  //  *
  //  * If your settings spec has no valididators then you can ignore this option.
  //  *
  //  * By default, violations are logged at error level. If you provide
  //  * your own function then this default behaviour will be disabled. You can
  //  * retain it by calling the default function passed as a second argument to
  //  * your function.
  //  */
  // onViolation?: (info: ViolationInfo, originalHandler: (info: ViolationInfo) => void) => void
}

function onFixup(info: FixupInfo): void {
  log.warn(
    'One of your setting values was invalid. We were able to automaticlaly fix it up now but please update your code.',
    info
  )
}

export function create<Input extends PlainObject, Data extends PlainObject = DataDefault<Input>>({
  spec,
  ...options
}: {
  spec: Spec<Input, Data>
} & Options): Manager<Input, Data> {
  if (isDevelopment()) {
    validateSpec(spec)
  }

  const state = {
    data: {} as Data,
    original: (undefined as any) as Data, // lazy
    metadata: {} as any, // Metadata<Data>,
  }

  initialize(spec, state.data, state.metadata)

  const api: Manager<Input, Data> = {
    data: state.data,
    metadata: state.metadata,
    change(input) {
      resolve(options, spec, input, state.data, state.metadata)
      return api
    },
    reset() {
      api.data = state.data = {} as any
      api.metadata = state.metadata = {} as any
      initialize(spec, state.data, state.metadata)
      return api
    },
    original() {
      const original = state.original ?? metadataToData(state.metadata, {})
      return original
    },
  }

  return api
}

function metadataToData<Data>(metadata: any, copy: PlainObject): Data {
  Lo.forOwn(metadata, (info, name) => {
    if (info.fields) {
      copy[name] = metadataToData(info.fields, {})
    } else {
      copy[name] = info.initial
    }
  })

  return copy as any
}

/**
 * Process the given input through the settings spec, resolving its shorthands,
 * fixups, validation and so on until finally assigning it into the setting data.
 * The input is not mutated. The data is.
 */
function resolve(options: Options, spec: any, input: any, data: any, metadata: any) {
  Lo.forOwn(input, (value, name) => {
    const specifier = spec[name]
    const isValueObject = Lo.isPlainObject(value)

    if (!specifier) {
      throw new Error(`Could not find a setting specifier for setting "${name}"`)
    }

    if (isValueObject && !specifier.fields) {
      throw new Error(
        `Setting "${name}" is not a namespace and so does not accept objects, but one given: ${inspect(
          value
        )}`
      )
    }

    if (!isValueObject && specifier.fields && !specifier.shorthand) {
      throw new Error(
        `Setting "${name}" is a namespace with no shorthand so expects an object but received a non-object: ${inspect(
          value
        )}`
      )
    }

    if (isValueObject) {
      // @ts-ignore
      resolve(options, specifier.fields, value, data[name], metadata[name].fields)
    } else if (specifier.shorthand) {
      if (specifier.shorthand) {
        log.debug('expanding shorthand', { name })
        let longhandValue
        try {
          longhandValue = specifier.shorthand(value)
        } catch (e) {
          throw ono(
            e,
            { name, value },
            `There was an unexpected error while running the namespace shorthand for setting "${name}". The given value was ${inspect(
              value
            )}`
          )
        }
        // @ts-ignore
        resolve(options, specifier.fields, longhandValue, data[name], metadata[name].fields)
      }
    } else {
      let resolvedValue = value

      /**
       * Run fixups
       */
      if (specifier.fixup) {
        let maybeFixedup
        try {
          maybeFixedup = specifier.fixup(resolvedValue)
        } catch (e) {
          throw ono(
            e,
            { name, value: resolvedValue },
            `Fixup for "${name}" failed while running on value ${inspect(resolvedValue)}`
          )
        }
        if (maybeFixedup) {
          resolvedValue = maybeFixedup.value
          /**
           * fixup handler
           */
          const fixupInfo = {
            before: value,
            after: maybeFixedup.value,
            name,
            messages: maybeFixedup.messages,
          }
          if (options.onFixup) {
            try {
              options.onFixup(fixupInfo, onFixup)
            } catch (e) {
              throw ono(e, { name }, `onFixup callback for "${name}" failed`)
            }
          } else {
            onFixup(fixupInfo)
          }
        }
      }

      /**
       * Run validators
       */
      if (specifier.validate) {
        let maybeViolation
        try {
          maybeViolation = specifier.validate(resolvedValue)
        } catch (e) {
          // todo use verror or like
          throw ono(
            e,
            { name, value: resolvedValue },
            `Validation for "${name}" unexpectedly failed while running on value ${inspect(resolvedValue)}`
          )
        }
        if (maybeViolation) {
          throw new Error(
            `Your setting "${name}" failed validation with value ${inspect(
              resolvedValue
            )}:\n\n- ${maybeViolation.messages.join('\n- ')}`
          )
        }
      }

      /**
       * Run type mappers
       */
      if (specifier.mapType) {
        resolvedValue = runTypeMapper(specifier.mapType, resolvedValue, name)
      }

      data[name] = resolvedValue
      metadata[name].value = resolvedValue
      metadata[name].from = 'set'
    }
  })

  return data
}

/**
 * Initialize the settings data with each datum's respective initializer
 * specified in the settings spec.
 */
function initialize(spec: any, data: any, metadata: any) {
  Lo.forOwn(spec, (specifier: any, name: string) => {
    if (specifier.fields) {
      const initializedNamespace = specifier.initial?.() ?? {}
      data[name] = data[name] ?? initializedNamespace
      metadata[name] = metadata[name] ?? {
        fields: Lo.mapValues(initializedNamespace, (v, k) => ({ value: v, from: 'initial', initial: v })),
      }
      initialize(specifier.fields, data[name], metadata[name].fields)
    } else {
      let value
      if (specifier.initial === undefined) {
        // the namespace might have initialized some data
        value = data[name] ?? undefined
      } else if (typeof specifier.initial === 'function') {
        try {
          value = specifier.initial()
        } catch (e) {
          throw ono(
            e,
            { name },
            `There was an unexpected error while running the initializer for setting "${name}"`
          )
        }
      } else {
        throw new Error(
          `Initializer for setting "${name}" was configured with a static value. It must be a function. Got: ${inspect(
            specifier.initial
          )}`
        )
      }

      log.trace('initialize value', { name, value })

      if (specifier.mapType) {
        value = runTypeMapper(specifier.mapType, value, name)
      }

      log.trace('map value type ', { name, value })
      data[name] = value
      metadata[name] = { value, from: 'initial', initial: value }
    }
  })
}

function runTypeMapper(typeMapper: any, value: any, fieldName: string): any {
  try {
    return typeMapper(value)
  } catch (e) {
    throw ono(
      e,
      { fieldName },
      `There was an unexpected error while running the type mapper for setting "${fieldName}"`
    )
  }
}

/**
 * Validate the spec for basic invariants.
 */
function validateSpec(spec: any) {
  Lo.forOwn(spec, (specifier: any, name: string) => {
    if (specifier.fields) {
      validateSpec(specifier.fields)
      return
    }

    if (specifier.entryFields) {
      validateSpec(specifier.entryFields)
      return
    }

    if (specifier.mapType !== undefined && typeof specifier.mapType !== 'function') {
      throw new Error(
        `Type mapper for setting "${name}" was invalid. Type mappers must be functions. Got: ${inspect(
          specifier.mapType
        )}`
      )
    }
  })
}

/**
 * Check if curerntly in production mode defined as
 * NODE_ENV environment variable equaling "production".
 */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

/**
 * Check if curerntly in development mode defined as
 * NODE_ENV environment variable not equaling "production".
 */
function isDevelopment(): boolean {
  return process.env.NODE_ENV !== 'production'
}
