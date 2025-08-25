// Test for consistent PO file ordering across multiple extractions
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { strictEqual } from 'node:assert'
import { AdapterHandler } from '../dist/handler.js'
import { getConfig } from '../dist/config.js'
import { adapter as vanilla } from '../dist/adapter-vanilla/index.js'

const createTempDir = async () => {
    const dir = join(tmpdir(), `wuchale-ordering-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, { recursive: true })
    return dir
}

const createTestFiles = async (dir) => {
    // Create subdirectory first
    await mkdir(join(dir, 'subdir'), { recursive: true })
    
    // Create test files with various messages to test ordering
    await writeFile(join(dir, 'file1.js'), `
        const msg1 = "Zebra message"
        const msg2 = "Alpha message" 
        const msg3 = "Beta message"
    `)
    
    await writeFile(join(dir, 'file2.js'), `
        const msg4 = "Beta message"  // Same as file1 - should be grouped
        const msg5 = "Gamma message"
        const msg6 = "Alpha message" // Same as file1 - should be grouped
    `)
    
    await writeFile(join(dir, 'subdir/file3.js'), `
        const msg7 = "Delta message"
        const msg8 = "Zebra message"  // Same as file1 - should be grouped
    `)
    
    // Create a proper loader file with content
    await writeFile(join(dir, 'loader.js'), 'export const loadCatalog = () => {}')
}

test('PO file ordering consistency across multiple extractions', async () => {
    const tempDir = await createTempDir()
    
    try {
        await createTestFiles(tempDir)
        
        const config = {
            sourceLocale: 'en',
            otherLocales: ['es'],
            adapters: {
                vanilla: {
                    ...vanilla({
                        files: join(tempDir, '**/*.js'),
                        catalog: join(tempDir, '{locale}'),
                    })
                }
            }
        }
        
        const poFilePath = join(tempDir, 'en.po')
        const extractionResults = []
        
        // Run extraction 10 times and collect results
        for (let i = 0; i < 10; i++) {
            // Clean up PO file before each run
            try {
                await rm(poFilePath)
            } catch {}
            
            const handler = new AdapterHandler(
                config.adapters.vanilla,
                'vanilla',
                config,
                'extract',
                'test',
                tempDir,
                { log: () => {}, info: () => {}, warn: () => {} }
            )
            
            await handler.init({})
            
            // Extract from all files
            const files = [
                join(tempDir, 'file1.js'),
                join(tempDir, 'file2.js'), 
                join(tempDir, 'subdir/file3.js')
            ]
            
            for (const file of files) {
                const content = await readFile(file, 'utf8')
                await handler.transform(content, file)
            }
            
            await handler.savePoAndCompile('en')
            
            // Read the generated PO file
            const poContent = await readFile(poFilePath, 'utf8')
            extractionResults.push(poContent)
        }
        
        // Remove timestamps from results for comparison since they vary by milliseconds
        const normalizePoContent = (content) => {
            return content
                .replace(/"PO-Revision-Date: [^"]*\\n"/g, '"PO-Revision-Date: NORMALIZED\\n"')
                .replace(/"POT-Creation-Date: [^"]*\\n"/g, '"POT-Creation-Date: NORMALIZED\\n"')
        }
        
        // Verify all extractions produced identical results (ignoring timestamps)
        const firstResult = normalizePoContent(extractionResults[0])
        for (let i = 1; i < extractionResults.length; i++) {
            strictEqual(
                normalizePoContent(extractionResults[i]), 
                firstResult,
                `Extraction ${i + 1} differs from first extraction`
            )
        }
        
        // Verify the content has expected ordering characteristics
        const lines = firstResult.split('\n')
        const msgidLines = lines.filter(line => line.startsWith('msgid ') && line !== 'msgid ""')
        
        // Extract just the message text for comparison
        const messages = msgidLines.map(line => line.match(/msgid "(.*)"/)?.[1]).filter(Boolean)
        const sortedMessages = [...messages].sort()
        
        strictEqual(
            JSON.stringify(messages),
            JSON.stringify(sortedMessages),
            'Messages should be in alphabetical order'
        )
        
        // Verify file references are sorted within each message block
        let currentMsgBlock = []
        let referenceBlocks = []
        
        for (const line of lines) {
            if (line.startsWith('#: ')) {
                currentMsgBlock.push(line.slice(3)) // Remove '#: '
            } else if (line.startsWith('msgid ') && line !== 'msgid ""') {
                if (currentMsgBlock.length > 0) {
                    referenceBlocks.push([...currentMsgBlock])
                    currentMsgBlock = []
                }
            }
        }
        
        // Check that file references within each block are sorted
        for (const block of referenceBlocks) {
            if (block.length > 1) {
                const sortedBlock = [...block].sort()
                strictEqual(
                    JSON.stringify(block),
                    JSON.stringify(sortedBlock),
                    `File references should be sorted within message block: ${JSON.stringify(block)}`
                )
            }
        }
        
    } finally {
        await rm(tempDir, { recursive: true, force: true })
    }
})

test('Messages with different alphabetical order are sorted correctly', async () => {
    const tempDir = await createTempDir()
    
    try {
        // Test with multiple files containing overlapping messages in function context
        await writeFile(join(tempDir, 'z-file.js'), `
            function test() {
                return "Zebra message";
            }
            function test2() {
                return "Beta message";
            }
        `)
        
        await writeFile(join(tempDir, 'a-file.js'), `
            function test3() {
                return "Alpha message";
            }
            function test4() {
                return "Beta message";  // Shared with z-file
            }
        `)
        
        await writeFile(join(tempDir, 'loader.js'), 'export const loadCatalog = () => {}')
        
        const config = {
            sourceLocale: 'en',
            otherLocales: [],
            adapters: {
                vanilla: {
                    ...vanilla({
                        files: join(tempDir, '**/*.js'),
                        catalog: join(tempDir, '{locale}'),
                    })
                }
            }
        }
        
        const handler = new AdapterHandler(
            config.adapters.vanilla,
            'vanilla', 
            config,
            'extract',
            'test',
            tempDir,
            { log: () => {}, info: () => {}, warn: () => {} }
        )
        
        await handler.init({})
        
        // Process files in non-alphabetical order to test sorting
        const files = [join(tempDir, 'z-file.js'), join(tempDir, 'a-file.js')]
        for (const file of files) {
            const content = await readFile(file, 'utf8')
            await handler.transform(content, file)
        }
        
        await handler.savePoAndCompile('en')
        
        const poContent = await readFile(join(tempDir, 'en.po'), 'utf8')
        
        // Verify messages are in alphabetical order
        const msgidPattern = /msgid "([^"]*)"/g
        const messages = [...poContent.matchAll(msgidPattern)]
            .map(match => match[1])
            .filter(msg => msg !== '') // Skip empty msgid
        
        const expectedOrder = ['Alpha message', 'Beta message', 'Zebra message']
        
        strictEqual(
            JSON.stringify(messages),
            JSON.stringify(expectedOrder),
            'Messages should be in alphabetical order'
        )
        
        // Verify file references are sorted
        const lines = poContent.split('\n')
        let foundBetaRefs = false
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('msgid "Beta message"')) {
                // Look for the file references before this msgid
                let refLines = []
                for (let j = i - 1; j >= 0 && lines[j].startsWith('#: '); j--) {
                    refLines.unshift(lines[j].slice(3)) // Remove '#: '
                }
                if (refLines.length >= 2) {
                    const sortedRefs = [...refLines].sort()
                    strictEqual(
                        JSON.stringify(refLines),
                        JSON.stringify(sortedRefs),
                        'File references should be sorted'
                    )
                    foundBetaRefs = true
                }
                break
            }
        }
        
        strictEqual(foundBetaRefs, true, 'Should have found and validated Beta message references')
        
    } finally {
        await rm(tempDir, { recursive: true, force: true })
    }
})