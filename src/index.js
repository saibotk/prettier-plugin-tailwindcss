import prettier from 'prettier'
import prettierParserHTML from 'prettier/parser-html'
import prettierParserPostCSS from 'prettier/parser-postcss'
import prettierParserBabel from 'prettier/parser-babel'
import prettierParserEspree from 'prettier/parser-espree'
import prettierParserMeriyah from 'prettier/parser-meriyah'
import prettierParserFlow from 'prettier/parser-flow'
import prettierParserTypescript from 'prettier/parser-typescript'
import { createContext as createContextFallback } from 'tailwindcss/lib/lib/setupContextUtils'
import { generateRules as generateRulesFallback } from 'tailwindcss/lib/lib/generateRules'
import resolveConfigFallback from 'tailwindcss/resolveConfig'
import * as recast from 'recast'
import * as astTypes from 'ast-types'
import * as path from 'path'
import * as fs from 'fs'
import requireFrom from 'import-from'
import requireFresh from 'import-fresh'

/**
 * TODO
 *
 * Transform object _values_ if they aren't part of a boolean expression? (Probably not)
 * markdown, mdx - prettier does not format html in markdown
 *
 * Plugin languages:
 * php - no
 * pug
 * svelte
 */

function bigSign(bigIntValue) {
  return (bigIntValue > 0n) - (bigIntValue < 0n)
}

function sortClasses(classStr, env) {
  let result = ''
  let parts = classStr.split(/(\s+)/)
  let classes = parts.filter((_, i) => i % 2 === 0)
  let whitespace = parts.filter((_, i) => i % 2 !== 0)

  if (classes[classes.length - 1] === '') {
    classes.pop()
  }

  let classNamesWithOrder = []
  for (let className of classes) {
    let order =
      env
        .generateRules(new Set([className]), env.context)
        .sort(([a], [z]) => bigSign(z - a))[0]?.[0] ?? null
    classNamesWithOrder.push([className, order])
  }

  classes = classNamesWithOrder
    .sort(([, a], [, z]) => {
      if (a === z) return 0
      // if (a === null) return options.unknownClassPosition === 'start' ? -1 : 1
      // if (z === null) return options.unknownClassPosition === 'start' ? 1 : -1
      if (a === null) return -1
      if (z === null) return 1
      return bigSign(a - z)
    })
    .map(([className]) => className)

  for (let i = 0; i < classes.length; i++) {
    result += `${classes[i]}${whitespace[i] ?? ''}`
  }

  return result
}

function createParser(original, transform) {
  return {
    ...original,
    parse(text, parsers, options) {
      let ast = original.parse(text, parsers, options)
      let tailwindConfig = {}
      let prettierConfigPath = prettier.resolveConfigFile.sync(options.filepath)
      let resolveConfig = resolveConfigFallback
      let createContext = createContextFallback
      let generateRules = generateRulesFallback

      if (prettierConfigPath) {
        let baseDir = path.dirname(prettierConfigPath)
        let tailwindConfigPath = path.resolve(baseDir, 'tailwind.config.js')
        if (fs.existsSync(tailwindConfigPath)) {
          tailwindConfig = requireFresh(tailwindConfigPath)
        }

        try {
          resolveConfig = requireFrom(baseDir, 'tailwindcss/resolveConfig')
          createContext = requireFrom(
            baseDir,
            'tailwindcss/lib/lib/setupContextUtils'
          ).createContext
          generateRules = requireFrom(
            baseDir,
            'tailwindcss/lib/lib/generateRules'
          ).generateRules
        } catch {}
      }

      let context = createContext(resolveConfig(tailwindConfig))
      transform(ast, { context, generateRules })
      return ast
    },
  }
}

function pathBelongsTo(path, type, name) {
  while (path.parent) {
    if (path.parent.value.type === type && path.name === name) {
      return true
    }
    path = path.parent
  }
  return false
}

function transformHtml(attributes, computedAttributes = []) {
  let transform = (ast, env) => {
    for (let attr of ast.attrs ?? []) {
      if (attributes.includes(attr.name)) {
        attr.value = sortClasses(attr.value, env)
      } else if (computedAttributes.includes(attr.name)) {
        if (!/[`'"]/.test(attr.value)) {
          continue
        }

        let ast = recast.parse(`let __prettier_temp__ = ${attr.value}`)
        let didChange = false

        let type = ast.program.body[0].declarations[0].init.type
        let transformObjectsAndArrays =
          type === 'ObjectExpression' || type === 'ArrayExpression'

        astTypes.visit(ast, {
          visitArrayExpression(path) {
            if (!transformObjectsAndArrays) {
              return false
            }
            this.traverse(path)
          },
          visitMemberExpression(_path) {
            return false
          },
          visitProperty(path) {
            if (!transformObjectsAndArrays) {
              return false
            }

            if (isStringLiteral(path.node.key)) {
              if (sortStringLiteral(path.node.key, env)) {
                didChange = true
              }
            }
            // we only want to sort _keys_ within objects
            // so we prevent further traversal here
            return false
          },
          visitLiteral(path) {
            if (pathBelongsTo(path, 'ConditionalExpression', 'test')) {
              return false
            }
            if (isStringLiteral(path.node)) {
              if (sortStringLiteral(path.node, env)) {
                didChange = true
              }
            }
            this.traverse(path)
          },
        })

        if (didChange) {
          attr.value = recast.print(
            ast.program.body[0].declarations[0].init
          ).code
        }
      }
    }

    for (let child of ast.children ?? []) {
      transform(child, env)
    }
  }
  return transform
}

function sortStringLiteral(node, env) {
  let result = sortClasses(node.value, env)
  let didChange = result !== node.value
  node.value = result
  if (node.extra) {
    // JavaScript (StringLiteral)
    let raw = node.extra.raw
    node.extra = {
      ...node.extra,
      rawValue: result,
      raw: raw[0] + result + raw.slice(-1),
    }
  } else {
    // TypeScript (Literal)
    let raw = node.raw
    node.raw = raw[0] + result + raw.slice(-1)
  }
  return didChange
}

function isStringLiteral(node) {
  return (
    node.type === 'StringLiteral' ||
    (node.type === 'Literal' && typeof node.value === 'string')
  )
}

function transformJavaScript(ast, env) {
  visit(ast, {
    JSXAttribute(node) {
      if (['class', 'className'].includes(node.name.name)) {
        if (isStringLiteral(node.value)) {
          sortStringLiteral(node.value, env)
        } else if (node.value.type === 'JSXExpressionContainer') {
          visit(node.value, (node, parent, key) => {
            if (
              node.type === 'ObjectExpression' ||
              node.type === 'MemberExpression'
            ) {
              return false
            }
            if (parent?.type === 'ConditionalExpression' && key === 'test') {
              return false
            }
            if (isStringLiteral(node)) {
              sortStringLiteral(node, env)
            } else if (node.type === 'TemplateLiteral') {
              for (let quasi of node.quasis) {
                let same = quasi.value.raw === quasi.value.cooked
                quasi.value.raw = sortClasses(quasi.value.raw, env)
                quasi.value.cooked = same
                  ? quasi.value.raw
                  : sortClasses(quasi.value.cooked, env)
              }
            }
          })
        }
      }
    },
  })
}

function transformCss(ast, env) {
  ast.walk((node) => {
    if (node.type === 'css-atrule' && node.name === 'apply') {
      node.params = sortClasses(node.params, env)
    }
  })
}

// export const options = {
//   unknownClassPosition: {
//     type: 'choice',
//     category: 'Tailwind CSS',
//     default: 'start',
//     choices: [
//       { value: 'start', description: 'TODO' },
//       { value: 'end', description: 'TODO' },
//     ],
//     description: 'TODO',
//   },
// }

export const parsers = {
  html: createParser(prettierParserHTML.parsers.html, transformHtml(['class'])),
  lwc: createParser(prettierParserHTML.parsers.lwc, transformHtml(['class'])),
  angular: createParser(
    prettierParserHTML.parsers.angular,
    transformHtml(['class'], ['[ngClass]'])
  ),
  vue: createParser(
    prettierParserHTML.parsers.vue,
    transformHtml(['class'], [':class'])
  ),
  css: createParser(prettierParserPostCSS.parsers.css, transformCss),
  scss: createParser(prettierParserPostCSS.parsers.scss, transformCss),
  less: createParser(prettierParserPostCSS.parsers.less, transformCss),
  babel: createParser(prettierParserBabel.parsers.babel, transformJavaScript),
  'babel-flow': createParser(
    prettierParserBabel.parsers['babel-flow'],
    transformJavaScript
  ),
  flow: createParser(prettierParserFlow.parsers.flow, transformJavaScript),
  typescript: createParser(
    prettierParserTypescript.parsers.typescript,
    transformJavaScript
  ),
  'babel-ts': createParser(
    prettierParserBabel.parsers['babel-ts'],
    transformJavaScript
  ),
  espree: createParser(
    prettierParserEspree.parsers.espree,
    transformJavaScript
  ),
  meriyah: createParser(
    prettierParserMeriyah.parsers.meriyah,
    transformJavaScript
  ),
}

// https://lihautan.com/manipulating-ast-with-javascript/
function visit(ast, callbackMap) {
  function _visit(node, parent, key, index) {
    if (typeof callbackMap === 'function') {
      if (callbackMap(node, parent, key, index) === false) {
        return
      }
    } else if (node.type in callbackMap) {
      if (callbackMap[node.type](node, parent, key, index) === false) {
        return
      }
    }

    const keys = Object.keys(node)
    for (let i = 0; i < keys.length; i++) {
      const child = node[keys[i]]
      if (Array.isArray(child)) {
        for (let j = 0; j < child.length; j++) {
          if (child[j] !== null) {
            _visit(child[j], node, keys[i], j)
          }
        }
      } else if (typeof child?.type === 'string') {
        _visit(child, node, keys[i], i)
      }
    }
  }
  _visit(ast)
}