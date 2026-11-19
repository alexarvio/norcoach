#!/usr/bin/env ruby
# frozen_string_literal: true

# Adds the NorcoachLive widget extension, the workout on the lock screen and in the Dynamic Island (19 Nov, Alex: "a
# pill on the lock screen of my iphone whenever there is an ongoing workout"), to App.xcodeproj, so the project file is
# never edited by hand. Safe to run again: what is already there is left as it is and only what is missing is added.
#
#   gem install xcodeproj
#   ruby mobile/ios/scripts/add_live_activity.rb
#
# Run on GitHub's Mac by .github/workflows/ios-project.yml (which uploads the project file to commit) and, while the
# target is not committed yet, by the TestFlight workflow before it archives.
#
# It adds: the NorcoachLive target (com.arvio.norcoach.LiveActivity, iOS 16.1) built from mobile/ios/App/LiveActivity;
# App/WorkoutAttributes.swift in both targets (one file, so the app and the extension can never drift); the plugin
# App/NorcoachLivePlugin.swift in the app; the extension embedded in App.app/PlugIns with a dependency on it; and
# ActivityKit weak-linked in the app, which stays on iOS 15.

require 'xcodeproj'

ROOT = File.expand_path('../App', __dir__)
PROJECT_PATH = File.join(ROOT, 'App.xcodeproj')
EXT_NAME = 'NorcoachLive'
EXT_BUNDLE_ID = 'com.arvio.norcoach.LiveActivity'
EXT_DIR = 'LiveActivity'
EXT_DEPLOYMENT = '16.1'
EXT_SOURCES = %w[NorcoachLiveBundle.swift WorkoutLiveActivity.swift].freeze
SHARED_SOURCE = 'WorkoutAttributes.swift'
APP_ONLY_SOURCE = 'NorcoachLivePlugin.swift'

(EXT_SOURCES + %w[Info.plist Assets.xcassets]).each do |f|
  abort("Missing #{EXT_DIR}/#{f}") unless File.exist?(File.join(ROOT, EXT_DIR, f))
end
[SHARED_SOURCE, APP_ONLY_SOURCE].each do |f|
  abort("Missing App/#{f}") unless File.exist?(File.join(ROOT, 'App', f))
end

project = Xcodeproj::Project.open(PROJECT_PATH)
app = project.targets.find { |t| t.name == 'App' } || abort('No App target')

def group_at(parent, path)
  parent.children.find { |c| c.isa == 'PBXGroup' && (c.path == path || c.name == path) } ||
    parent.new_group(path, path)
end

def file_in(group, path)
  group.files.find { |f| f.path == path } || group.new_reference(path)
end

def add_once(phase, ref)
  return if phase.files_references.include?(ref)

  phase.add_file_reference(ref, true)
end

changes = []

# The target, new or as it is.
ext = project.targets.find { |t| t.name == EXT_NAME }
if ext.nil?
  ext = project.new_target(:app_extension, EXT_NAME, :ios, EXT_DEPLOYMENT, nil, :swift)
  changes << "target #{EXT_NAME}"
end

# Its build settings, the same every run. The version numbers follow the app's, as the App Store wants them equal;
# the TestFlight workflow passes CURRENT_PROJECT_VERSION and the app's MARKETING_VERSION on the command line, which
# reach both, so the copy here only matters for a build made by hand.
app_marketing = app.build_configurations.map { |c| c.build_settings['MARKETING_VERSION'] }.compact.first || '1.0'
ext.build_configurations.each do |config|
  s = config.build_settings
  s['PRODUCT_NAME'] = '$(TARGET_NAME)'
  s['PRODUCT_BUNDLE_IDENTIFIER'] = EXT_BUNDLE_ID
  s['INFOPLIST_FILE'] = "#{EXT_DIR}/Info.plist"
  s['GENERATE_INFOPLIST_FILE'] = 'NO'
  s['IPHONEOS_DEPLOYMENT_TARGET'] = EXT_DEPLOYMENT
  s['SDKROOT'] = 'iphoneos'
  s['SKIP_INSTALL'] = 'YES'
  s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['MARKETING_VERSION'] = app_marketing
  s['CURRENT_PROJECT_VERSION'] = '1'
  s['SWIFT_VERSION'] = '5.0'
  s['TARGETED_DEVICE_FAMILY'] = '1'
  s['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = config.name == 'Debug' ? 'DEBUG' : ''
  s.delete('ASSETCATALOG_COMPILER_APPICON_NAME')
end

# The files: the extension's own group, and the shared struct and the plugin in the app's.
ext_group = group_at(project.main_group, EXT_DIR)
app_group = project.main_group.children.find { |c| c.isa == 'PBXGroup' && c.path == 'App' } || abort('No App group')

EXT_SOURCES.each { |f| add_once(ext.source_build_phase, file_in(ext_group, f)) }
file_in(ext_group, 'Info.plist') # in the group to see, in no build phase
add_once(ext.resources_build_phase, file_in(ext_group, 'Assets.xcassets'))

shared = file_in(app_group, SHARED_SOURCE)
add_once(app.source_build_phase, shared)
add_once(ext.source_build_phase, shared)
add_once(app.source_build_phase, file_in(app_group, APP_ONLY_SOURCE))

# SwiftUI and WidgetKit as the Xcode template links them (Swift would autolink them anyway).
existing = ext.frameworks_build_phase.files_references.compact.map { |r| r.path.to_s }
%w[WidgetKit SwiftUI].each do |fw|
  ext.add_system_framework(fw) unless existing.any? { |p| p.end_with?("#{fw}.framework") }
end

# Embedded in App.app/PlugIns, built before the app.
embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' || p.dst_subfolder_spec == '13' }
if embed.nil?
  embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
  changes << 'Embed Foundation Extensions phase'
end
embed.symbol_dst_subfolder_spec = :plug_ins
embed.dst_path = ''
embedded = embed.files.find { |bf| bf.file_ref == ext.product_reference }
if embedded.nil?
  embedded = embed.add_file_reference(ext.product_reference, true)
  changes << "#{EXT_NAME}.appex embedded"
end
embedded.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

unless app.dependencies.any? { |d| d.target == ext }
  app.add_dependency(ext)
  changes << "App depends on #{EXT_NAME}"
end

# Automatic signing for it too, as the app has.
target_attributes = (project.root_object.attributes['TargetAttributes'] ||= {})
entry = (target_attributes[ext.uuid] ||= {})
entry['CreatedOnToolsVersion'] ||= '16.0'
entry['ProvisioningStyle'] = 'Automatic'

# The app stays on iOS 15: ActivityKit (16.1) weak-linked, so an older iPhone still opens it; every use of it is behind
# #available in the Swift.
app.build_configurations.each do |config|
  raw = config.build_settings['OTHER_LDFLAGS']
  flags = raw.is_a?(Array) ? raw.dup : (raw ? raw.split : ['$(inherited)'])
  next if flags.include?('ActivityKit')

  config.build_settings['OTHER_LDFLAGS'] = flags + ['-weak_framework', 'ActivityKit']
  changes << "ActivityKit weak-linked (#{config.name})"
end

project.save
puts(changes.empty? ? 'Nothing to add: the Live Activity target is in the project.' : "Added: #{changes.join(', ')}.")
